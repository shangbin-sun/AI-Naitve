# Agent 与 Subagent 组织规则的加载

更新：2026-09-10。

## 文档层级

- 用户级 Codex 约定：默认 ~/.codex/AGENTS.md；适用于后续使用该 Codex 配置的任务，已有会话不承诺热更新。
- 工作区约定：ai_native/AGENTS.md；AI-Naitve/AGENTS.md 提供仓库入口。工作区规则是本项目的可共享副本，用户级文件是安装副本，更新组织约定时同步两处。
- 服务端运行规则：backend/app/instructions/organization.md，随 Python 包分发。服务端不读取个人全局文件作为业务组织规则。
- 员工职责与文件：数据库仍为权威来源，工作空间是不可变定义快照。

## 原生发现与服务端显式加载

交互式 Codex 使用官方 AGENTS.md 层级发现和 Skills 按需加载机制。服务端精简配置保留 project_doc_max_bytes=0 和宿主技能隔离，采用显式加载；两种机制不可混称。

每次新任务把组织规则正文纳入定义哈希，并写入冻结目录的 AGENTS.md。主 Agent 的 baseInstructions 加载该快照中的规则正文。begin 返回 instruction_bundle，包含快照哈希、组织规则、角色文件、员工 AGENTS.override.md（优先）或 AGENTS.md，以及员工 .agents/skills 下的 SKILL.md 路径。

主 Agent 必须把 bundle 传给子 Agent，子 Agent 执行前读取规则，按 name/description 匹配并读取所需技能。普通 Markdown、参考资料和附件不自动获得指令地位。平台提供路径和行为约束，但尚未实现对模型每次文件读取的强制审计；不能据此宣称每个技能都已执行。

新规则只影响新任务。恢复沿用旧快照；升级前没有 organization_instructions 的旧运行保留兼容行为，不修改其历史快照。管理聊天继续使用 project-operations/SKILL.md，不把执行子 Agent 的职责强加给管理聊天。

数据库保存组织、版本和状态；Markdown 保存规则和方法。更新运行规则时编辑 organization.md，更新员工时使用业务工具，避免直接改冻结目录。

## 验证

新增测试覆盖冻结员工规则和技能路径、恢复后的 bundle 稳定性、组织规则变更生成新哈希且不覆盖旧快照。未在本次验证中调用真实模型或宣称子 Agent 已实际读取文件。

## 官方来源

- [AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- [Skills](https://learn.chatgpt.com/docs/build-skills)


## 项目和员工的独立规则（2026-09-10 补充）

新项目创建时将默认 AGENTS.md 和 project-workflow 技能复制到 project_instructions 表，独立版本管理。AI 员工创建时在自己的 files 中复制 AGENTS.md 和 employee-work 技能；已有员工只补缺失文件，保留自定义内容。

项目工作空间根目录显示 AGENTS.md、.agents/skills/project-workflow/SKILL.md 和 employees/<员工key>/ 下的个人规则与技能。工作空间允许浏览 .agents；打开当前规则或技能后点击“编辑规则”保存。保存经过数据库版本检查，旧版本返回 409。直接修改磁盘投影不会保存到数据库，刷新可能被覆盖；请使用页面或 API。

GET /api/workspaces/{project}/file 返回可编辑标记与版本；PUT 同路径提交 path、text、expected_version，只允许当前项目或员工的规则/技能文件。运行和定义快照只读。

每次运行冻结 project_files 和 instructions_version。主 Agent 显式加载冻结的项目规则，begin 返回 project_rules_path、project_skill_paths 和个人规则/技能路径；子 Agent 按派工指令读取。管理会话在每轮读取当前定义快照中的项目规则。默认模板更新不会覆盖已有项目或员工同名文件。

验证：后端项目隔离、编辑冲突、冻结与补齐测试通过；前端构建及工作空间保存流程测试通过。未进行真实模型调用验收。
