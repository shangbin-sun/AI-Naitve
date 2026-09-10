"""Start both local services and stop their process groups together."""
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
children = []


def stop(*_):
    for child in children:
        if child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
    for child in children:
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()


if __name__ == '__main__':
    for port in (8000, 5173):
        with socket.socket() as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind(('127.0.0.1', port))
            except OSError:
                sys.exit(f'端口 {port} 已被占用，请先停止已有服务。')
    signal.signal(signal.SIGINT, lambda *_: sys.exit(0))
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    try:
        children.append(subprocess.Popen([str(ROOT/'backend/.venv/bin/python'), '-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8000'], cwd=ROOT/'backend', start_new_session=True))
        frontend_env = os.environ.copy()
        node22 = Path('/opt/homebrew/opt/node@22/bin')
        if node22.is_dir():
            frontend_env['PATH'] = str(node22) + os.pathsep + frontend_env.get('PATH', '')
        children.append(subprocess.Popen(['npm', 'run', 'dev'], cwd=ROOT/'frontend', env=frontend_env, start_new_session=True))
        print('\nAI 项目工厂：http://127.0.0.1:5173\nAPI 文档：http://127.0.0.1:8000/docs\nCtrl+C 停止全部服务。\n', flush=True)
        while all(child.poll() is None for child in children):
            time.sleep(.5)
        sys.exit(1)
    finally:
        stop()
