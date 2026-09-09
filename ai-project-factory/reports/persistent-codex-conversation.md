> 本文是此前阶段记录；新增项目 MCP 和员工引用后的行为见 [项目工具与员工优化](project-tools.md)。当前指引以 `backend/app/codex_session.py` 与 `backend/app/skills/project-operations/SKILL.md` 为准。

# 持久 Codex 会话验收

2026-09-09：普通项目聊天改为持久 Codex 会话，前端是消息与状态显示窗口。一个常驻 app-server 管理多个项目，各项目保存独立 threadId。每轮仅发送新文字和本条附件，普通聊天不要求结构化输出，也不重复发送历史、完整草稿或参考资料。恢复接口、流式输出与压缩事件依据 [Codex App Server 官方文档](https://learn.chatgpt.com/docs/app-server)，同时用本机生成的协议 schema 与真实调用验证。

## 数据与兼容

新增 codex_conversations 和 chat_operations 两张表，不修改原表。已有显示历史全部保留，第一次切换时通过 thread/inject_items 一次性导入过去的用户/助手消息；导入成功后才绑定项目映射，失败重试不会在同一会话重复导入。导入不触发模型回复。以后只追加本条消息，图片也不重复传输。

原项目方案、员工与修订仍保存在应用数据库。聊天不修改这些数据。单独的“生成／更新方案”按钮基于当前会话分支生成结构化结果，保留原来的校验、版本冲突保护与原子保存。分支排除的是返回体中的历史 turns（excludeTurns），不是模型可用的父会话历史。本机 paginated 会话对 ephemeral fork 要求该字段，已通过实测适配。

旧 `/api/designs/{id}/messages` 继续兼容原方案生成语义，当前界面普通聊天使用 `/api/workspaces/{id}/messages`，显式方案操作使用 `/api/workspaces/{id}/plan`。

## 生命周期

初次 thread/start(ephemeral=false)；同进程后续重用已加载 threadId；服务重启时 thread/resume 恢复原 ID。未知或不可恢复 ID 报错，不悄悄创建空会话。停止通过 turn/interrupt，仅作用于当前项目；进程退出才关闭共享 app-server。中途连接失败不自动重发请求，防止重复输入。Codex 上下文压缩的 started/completed 事件进入页面进度。

现有权限范围保持聊天用途；没有在本次迁移中开放命令、文件写入或外部工具执行。

## 验证

- 86 项后端测试、63 项前端测试通过；前端生产构建通过。
- 协议测试验证文字空白/换行原样传递；后续输入不含历史 JSON 或 schema；图片只随所属消息提交；历史只导入一次。
- 单元测试覆盖主线程复用、重启恢复、方案分支、取消项目隔离、压缩事件、恢复失败不新建会话、token 用量按 last 而不是累计 total 记录。
- 真实调用：首次记住测试代号，下一轮只发询问，能回答原代号；关闭服务再启动后仍返回同一代号，threadId 相同；另一个项目使用不同 ID，不得到该代号。
- 真实迁移：在测试数据库预置两条旧对话，新会话成功导入，能回答旧消息中的代号；导入数量为 2。
- 真实方案生成：从持久会话 fork 生成两成员的就绪方案，应用版本从 0 到 1，主 threadId 保持不变。
- 真实压缩：调用 thread/compact/start，收到 contextCompaction 完成与 turn 完成事件；后续普通聊天仍能回答旧代号。

真实测试都使用 `.data/persistent-probe/probe.db`，没有向用户项目插入测试对话。测试会话作为 Codex 持久会话存在于其会话存储中。

## 延迟边界

本次一次常驻后续请求约 1.9 秒首字；压缩后一次约 3 秒。首次建立、旧历史导入后的第一次回复、重启恢复都观察到更长等待（约 9–37 秒）；结构化方案生成约 41 秒。以上为不同请求的小样本，不构成速度承诺。本次核心交付是正确复用 Codex 的持久上下文与压缩能力。
