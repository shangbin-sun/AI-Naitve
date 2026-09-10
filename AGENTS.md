# 项目 Agent 组织约定

本仓库遵循 [Agent 与 Subagent 组织规则](docs/agent-organization-conventions.md)，开始组织、员工或运行机制相关工作前读取该文件。
项目运行时的受控组织规则位于 ai-project-factory/backend/app/instructions/organization.md。
数据库是业务状态权威来源。服务端采用显式加载与冻结快照，不依赖宿主个人 AGENTS.md 或 Skills 自动发现。
修改运行机制后使用 backend/.venv/bin/python -m pytest 验证相关后端测试；保留已有未提交改动。

产品术语统一为 AI Team（AI 团队）；界面、提示词和新文档不再将业务团队称为项目。现有 API、目录标识和数据 ID 保留兼容。
