#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
factory_python="${PYTHON:-python3}"
if ! "$factory_python" -c 'import sys; assert sys.version_info >= (3,11)' 2>/dev/null; then
  factory_python="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3"
fi
if ! "$factory_python" -c 'import sys; assert sys.version_info >= (3,11)' 2>/dev/null; then
  echo '需要 Python 3.11+，请用 PYTHON=/path/to/python3 bash scripts/setup.sh 指定。'; exit 1
fi
"$factory_python" -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.lock.txt -e 'backend[test]'
(cd frontend && npm ci)
echo '安装完成。启动：backend/.venv/bin/python scripts/dev.py'
