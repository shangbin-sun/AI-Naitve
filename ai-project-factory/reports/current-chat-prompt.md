> 本文是此前阶段记录；新增项目 MCP 和员工引用后的行为见 [项目工具与员工优化](project-tools.md)。当前指引以 `backend/app/codex_session.py` 与 `backend/app/skills/project-operations/SKILL.md` 为准。

# 当前项目助手输入（持久会话版，2026-09-09）

普通聊天首次建立会话时，应用设置以下基础指令。这不包含 Codex 自身的内部指令。

```text
你是项目助手，通过中文与用户讨论问题、需求和方案。直接以自然语言回答，不要求 JSON。
此会话的历史与上下文压缩由 Codex 管理。普通对话只供讨论，不会自动修改应用中保存的方案。
用户需要保存结构化团队方案时，可使用页面的“生成／更新方案”按钮；不要宣称已保存或执行。
当前是对话模式，不执行命令、不修改文件、不调用外部工具。
```

每轮向同一个 threadId 发送 turn/start，input 的文本就是用户本条原文，另附本条图片。没有 current_draft、conversation JSON、reference_sources 或 outputSchema。既有旧对话仅在第一次迁移时通过 thread/inject_items 导入一次，不随每轮重发。

“生成／更新方案”是独立操作：从主会话建立分支，发送当前草稿、资料与方案 schema，校验后保存结果，不把主会话变成结构化输出会话。
