"""Run the single-user local browser IDE. No public listener is opened."""
import json
import os
from pathlib import Path
import shutil
import sys

ROOT = Path(__file__).resolve().parents[1]
if __name__ == '__main__':
    binary = shutil.which('code-server')
    if not binary:
        sys.exit('请先安装 code-server（macOS：brew install code-server）')
    state = ROOT / '.data' / 'web-editor'
    state.mkdir(parents=True, exist_ok=True)
    config = state / 'config.yaml'
    if not config.exists():
        config.write_text('bind-addr: 127.0.0.1:8787\nauth: none\ncert: false\n')
    settings = state / 'user' / 'User' / 'settings.json'
    settings.parent.mkdir(parents=True, exist_ok=True)
    if not settings.exists():
        settings.write_text(json.dumps({'workbench.colorTheme':'Default Light Modern', 'workbench.startupEditor':'none', 'telemetry.telemetryLevel':'off', 'editor.editContext':False, 'workbench.secondarySideBar.defaultVisibility':'hidden'}, indent=2))
    outputs = ROOT / '.data' / 'output-workspaces'
    outputs.mkdir(parents=True, exist_ok=True)
    os.execv(binary, [binary, '--config', str(config), '--bind-addr', '127.0.0.1:8787', '--user-data-dir', str(state/'user'), '--extensions-dir', str(state/'extensions'), '--disable-telemetry', '--disable-update-check', str(outputs)])
