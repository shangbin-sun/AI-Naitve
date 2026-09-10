import os
import shutil
from dataclasses import dataclass
from pathlib import Path


@dataclass
class Settings:
    data_dir: Path
    database_url: str
    codex_bin: str
    codex_model: str
    timeout_seconds: int
    codex_reasoning_effort: str = "medium"
    chat_reasoning_effort: str = "medium"
    chat_lean_context: bool = True
    run_timeout_seconds: int = 1800

    @classmethod
    def from_env(cls):
        root = Path(__file__).resolve().parents[2]
        data = Path(os.getenv("FACTORY_DATA_DIR", str(root / ".data"))).resolve()
        bundled = "/Applications/ChatGPT.app/Contents/Resources/codex"
        binary = os.getenv("CODEX_BIN") or shutil.which("codex")
        if not binary and Path(bundled).is_file():
            binary = bundled
        return cls(
            data_dir=data,
            database_url=os.getenv("DATABASE_URL", f"sqlite:///{data / 'factory.db'}"),
            codex_bin=binary or "codex",
            codex_model=os.getenv("CODEX_MODEL", ""),
            timeout_seconds=int(os.getenv("CODEX_TIMEOUT_SECONDS", "300")),
            codex_reasoning_effort=os.getenv("CODEX_REASONING_EFFORT", "medium"),
            chat_reasoning_effort=os.getenv("CODEX_CHAT_REASONING_EFFORT", os.getenv("CODEX_REASONING_EFFORT", "medium")),
            chat_lean_context=os.getenv("FACTORY_CHAT_LEAN_CONTEXT", "1") != "0",
            run_timeout_seconds=int(os.getenv('CODEX_RUN_TIMEOUT_SECONDS', '1800')),
        )
