# AI Native · AI 项目工厂

通过对话设计团队与工作流程，管理 AI 员工、任务运行和产出文件。

## 目录

- [`ai-project-factory`](ai-project-factory)：Python 后台、React 前端、测试和启动脚本。
- [`docs`](docs)：产品定义、设计与验收文档。
- [运行节点与续跑说明](ai-project-factory/docs-run-flow.md)
- [本地部署与 Windows 原生 PowerShell 说明](ai-project-factory/README.md)

## 本地启动

需要 Python 3.11+、Node.js 20.19+ 或 22.13+，以及已安装并登录的 Codex CLI。本机编辑器使用 VS Code；Windows 使用原生 PowerShell，不使用 WSL。完整的 Windows 安装、配置和运行说明见 [`ai-project-factory/README.md`](ai-project-factory/README.md)。

```bash
git clone git@github.com:shangbin-sun/AI-Naitve.git
cd AI-Naitve/ai-project-factory
```

### Linux/macOS

```bash
bash scripts/setup.sh
backend/.venv/bin/python scripts/dev.py
```

### Windows PowerShell

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\scripts\setup_win.ps1
.\scripts\dev_win.ps1
```

- 平台：http://127.0.0.1:5173/
- API 文档：http://127.0.0.1:8000/docs

工作数据库、员工运行文件、参考项目数据和登录凭据保留在本地，不随 Git 提交。新环境需要重新配置 Codex 登录并导入自己的参考资料。目录中的验收报告是历史记录，不代表新环境已生成这些运行数据。

当前支持需求与架构、源码开发修复和参考测试执行。任意 DAG 调度及部署执行尚未接入；推送到 GitHub 只同步源码，不会自动部署在线服务。
