"""Small platform adapters for subprocess groups and shutdown.

The application runs long lived Codex and test processes. POSIX can use a
new process group and ``killpg``; Windows needs a new process group plus
``taskkill /T`` to include descendants. Keeping these details here avoids
platform-specific imports in the request and scheduling paths.
"""
import asyncio
import os
import signal
import subprocess


def subprocess_group_kwargs():
    """Return subprocess options that isolate a child process tree."""
    if os.name == "nt":
        return {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
    return {"start_new_session": True}


async def _taskkill(pid, force=True, timeout=3):
    command = ["taskkill", "/PID", str(pid), "/T"]
    if force:
        command.append("/F")
    killer = await asyncio.create_subprocess_exec(
        *command,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        await asyncio.wait_for(killer.wait(), timeout)
    except asyncio.TimeoutError:
        try:
            killer.kill()
        except ProcessLookupError:
            pass
        await killer.wait()


async def terminate_process(proc, timeout=3):
    """Terminate ``proc`` and its descendants, then wait for the parent."""
    if proc is None:
        return
    if proc.returncode is None:
        if os.name == "nt":
            try:
                await _taskkill(proc.pid, timeout=timeout)
            except (OSError, ProcessLookupError):
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
        else:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(proc.wait(), timeout)
            except asyncio.TimeoutError:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
    if proc.returncode is None:
        try:
            proc.kill()
        except ProcessLookupError:
            pass
    await proc.wait()
