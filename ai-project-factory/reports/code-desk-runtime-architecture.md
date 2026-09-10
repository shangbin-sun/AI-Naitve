# AI 工作室：主智能体与子智能体技术设计

2026-09-10。本设计覆盖本地 Codex CLI App Server，取代此前由平台独立决定流程推进的设计。实施状态与测试证据见 runtime-migration-checklist.md。

## 职责

- 项目助手：每项目持续 Codex 会话，cwd 为项目根目录；只读目录，配置修改经现有 project_factory MCP 的版本校验工具。management 只保存管理元数据。
- 运行主智能体：每个 run 独立持久 thread；读取冻结定义，使用原生 spawn / wait 调度员工子智能体。
- 子智能体：员工在某个节点上的执行实例；只处理传入节点，在 attempt 工作目录产出。
- 平台：校验依赖和真实子会话关联、保存人工答复及产物 hash、取消与恢复，不替模型决定任务拆解。

员工定义不是子会话。一个员工可以承担多个节点；每个节点以 node key 和 attempt ID 关联其子 thread。单节点和完整工作流共用 AgentTask / AgentRun 模型，scope 分别为 node / workflow。

聊天右侧展示与上下文绑定的文件浏览器。项目作用域解析为项目根目录；单节点/完整任务的运行与追问解析为当前 run 根目录，与 Codex cwd 一致。根路径由服务器依据 project/run 归属计算，客户端只能传相对路径。当前追问复用运行主会话，不另建脱离运行的任务聊天。目录读取不执行文件内容，也不提供绕过项目版本校验的配置写接口。

## 目录

```text
projects/<project_id>/
  definition/versions/<sha256>/
    definition.json
    employees/<employee_key>/
    references/
    attachments/
  management/definition-ref.json
  node-tasks/<timestamp-slug-random>/
    manifest.json
    runs/<timestamp-run-random>/
      manifest.json
      inputs/task.json
      nodes/<node_key>/attempts/<attempt_id>/
        manifest.json
        inputs/context.json
        workspace/
        outputs/
        logs/
      handoffs/
      outputs/index.json
      logs/
  workflow-tasks/<timestamp-slug-random>/
    ...与 node-tasks 完全相同...
```

SQLite 是定义和运行状态的事实来源；JSON 是可导出投影。定义内容、员工文件、资料内容与附件摘要一起参与 SHA-256，不仅依赖项目数字版本。创建运行时固定 snapshot；恢复不会刷新它。任务 ID 使用 UTC 微秒时间戳、短名及随机后缀，并由数据库主键兜底。request_id 在项目内幂等，复用时内容必须一致。

## 文件与工具

目录承担大内容读取和运行产物；受控工具承担业务状态转换。项目修改仍使用 MCP。运行工具采用 App Server 的 dynamicTools / item/tool/call：由服务端提供真实调用 threadId，只有对应主会话能够 begin、finish、请求人工；子会话不能伪造项目或主会话 ID。这与 MCP 共享“工具控制状态、目录承载内容”的边界，不暴露项目管理写权限给运行会话。

平台从 collabAgentToolCall 记录真实派生的 receiverThreadIds 和 agentsStates。begin 校验依赖；finish 要求匹配已派生子会话且已完成，并验证成果位于该节点 outputs 内、不是符号链接且大小受限。后继节点只读取已登记的上游成果。运行 completed 要求所有必需节点完成；模型回复不是完成凭据。产物文件通过不代表业务质量自动通过，验收仍依据任务和人工反馈。

## 恢复与边界

状态：queued、running、waiting_human、completed、interrupted、cancelled。服务重启将未结束运行标记 interrupted，不自动重发。继续使用同一主 thread 与原 snapshot。人工答复归档在当前 run，答复后可继续。取消关闭该运行独立 App Server 进程组，不影响其他运行或项目聊天。

原生子智能体共享 run 级 workspace-write 沙箱；公共 definition 在可写范围之外。节点目录是协作约定，不能宣传为每员工独立的 OS 沙箱。真正的员工间强隔离需要独立进程/容器执行器，属于后续能力。当前不实现多机租约、分布式 outbox、无条件自动重试或外部副作用 exactly-once。

## 兼容与验收

新增 agent_tasks / agent_runs 表，不改既有主键；原任务与 employee.py、代码交付验证保留。界面增加统一智能体任务入口。迁移不搬移或删除旧 .data 记录。

必须验证：快照冻结、两类目录对齐、串并行依赖、真实原生子会话、伪造提交拒绝、路径边界、人工处理、取消与重启恢复、旧功能回归、前端生产构建。模拟协议测试和本机 CLI 测试分别记录，不把模拟结果当真实能力。

## 依据

本机 codex-cli 0.153.4 导出的 experimental JSON schema 已核对 dynamicTools、item/tool/call 与 collabAgentToolCall 字段。[App Server 官方文档](https://learn.chatgpt.com/docs/app-server)；[原生子智能体文档](https://learn.chatgpt.com/docs/agent-configuration/subagents)。

Kubernetes 的控制器、Job 与持久卷可作为未来部署的基础设施参考；kube-scheduler 不负责员工业务依赖，本次不引入 Kubernetes。[Controllers](https://kubernetes.io/docs/concepts/architecture/controller/)。
