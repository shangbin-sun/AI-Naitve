# AI 工作室：工作目录现状与架构方案

> 后续方案已实施：单节点任务与完整任务分别置于 `node-tasks` 和 `workflow-tasks`，内部结构完全一致，并固定 definition 版本。当前实现以 [Codex 运行技术设计](code-desk-runtime-architecture.md) 和 [验收记录](native-runtime-validation.md) 为准；本文保留改造前的现状审计。

日期：2026-09-10。本文为代码与本地运行状态审计后的设计建议，尚未实施目录迁移。“Code Desk”暂按当前接入的 Codex CLI 理解；同时记录网页编辑器目录。

## 1. 结论

采用“项目 → 任务 → 运行 → 员工执行”的层级。每个项目有一个完整业务工作目录，每次运行有独立目录，同一员工在一次运行中多次执行也分别留存。项目调优和业务任务分开，但共享同一份项目资料目录与员工版本库。

必须区分：员工定义是长期资产；员工执行是本次运行中的输入、过程、工作副本和产物。不能把所有执行写进员工的长期工程目录。

“完整项目目录”指包含可导出、可恢复的业务文件和索引，不要求把全局登录凭据、工具链缓存及 Codex 内部会话库复制进项目。

## 2. 当前实现

默认数据根是仓库内 `.data`，可通过 `FACTORY_DATA_DIR` 覆盖；数据库可通过 `DATABASE_URL` 独立配置。

| 数据/工作 | 当前存放方式 | 含义与限制 |
| --- | --- | --- |
| 项目方案、聊天、版本 | `factory.db` 的 designs/messages/revisions 等表 | API workspace 是逻辑项目，尚无对应独立项目目录 |
| 员工配置和工程 | employees.profile/files JSON | 浏览器编辑的是数据库字段；运行时再把工程写出 |
| 参考资料 | sources 表；源码副本在 `evidence/<source_id>` | 普通文本资料与源码快照存储不同 |
| 聊天附件 | chat_attachments 表的二进制字段 | 尚未统一到项目资料资产库；文本正文与图片分别送入模型 |
| 项目聊天 | 共用 `.data/codex-chat` | 项目有独立 threadId，但工作目录相同 |
| 结构化模型调用 | `.data/design-<随机值>` | 临时目录，调用结束删除；并非业务工程执行目录 |
| 分析、检查 | `analyses/<evaluation_id>`、`checks/<evaluation_id>` | 按功能划分，未嵌套在项目下 |
| 员工研发与试运行 | `employee-builds/<evaluation_id>`、`employee-runs/<evaluation_id>` | 测试用例和研发尝试各有副本 |
| 交付运行 | `deliveries/<evaluation_id>` | 包含基线与尝试等，当前是专用代码交付执行器 |
| 可编辑产物与过程归档 | `output-workspaces/<evaluation_id>/employees/<角色>/...` | 文件编辑副本与原始运行证据分开，重新打开保留人工修改 |

当前 WorkTask 是逻辑任务，TaskRun 关联 Evaluation；还没有统一的任务/运行文件根。数据库中的 `Project` 模型实际表示历史方案快照，持续项目标识来自 `Design.id`，后续不能误用快照 ID 作为目录根。

现有过程归档按 `it_analysis`、`it_development`、`platform_validation` 固定角色分组，并非任意员工 ID。现有单员工运行使用 JSON 输入和 stdout/stderr；交付调用在结果中记录模型输入、事件、输出等信息。尚未实现任意工作流下每个员工的统一执行实例。

本地生产数据库检查时有 2 个逻辑项目、1 位 AI 员工、3 个聊天附件；任务、任务运行、资料及评估记录均为 0。因此运行目录描述来自代码路径，不代表当前用户已经执行过这些任务。`.data` 内还有此前验证用的 probe 目录，应视为测试数据而非业务项目。

## 3. Codex 与编辑器实际目录

本次检查到的 app-server 进程 cwd 为：

```text
/Users/bingo/Desktop/code/ai_native/AI-Naitve/ai-project-factory/backend
```

原因是启动 app-server 未指定进程 cwd，继承后端目录。该目录与模型会话的 cwd 是两个概念。

两个项目的会话元数据均确认 thread cwd 为：

```text
/Users/bingo/Desktop/code/ai_native/AI-Naitve/ai-project-factory/.data/codex-chat
```

项目 MCP 子进程 cwd 也配置为 backend，用于加载 Python 模块。工具依靠项目绑定和服务端校验定位数据，不能把 MCP 进程 cwd 当成业务目录。

本机对应会话文件位于 `/Users/bingo/.codex/sessions/2026/09/09/` 和 `/Users/bingo/.codex/sessions/2026/09/10/`。应用保存 threadId 映射，Codex 管理内部会话历史。当前项目目录本身不能独立恢复全部 Codex 内部状态。

项目助手现有会话使用只读沙箱且关闭 shell 工具，业务写入通过 MCP；仅修改 cwd 不会自动获得文件操作能力或形成安全隔离。

若“Code Desk”指的是网页 VS Code：其默认目录为 `.data/output-workspaces`，通过任务入口打开时会定位到具体运行/员工目录。

## 4. 建议目录

初期仍以 FACTORY_DATA_DIR 为总根，避免立即引入任意外部路径。以后再支持用户选择项目根目录。

```text
.data/
├── factory.db                       # 平台索引、状态与版本事务
├── cache/                           # 可共享的依赖/工具链缓存
├── service/                         # 服务日志、网页编辑器状态
└── projects/<project_id>/
    ├── project.json                 # 导出清单：ID、标题、schema/修订版本
    ├── workflow/                    # 当前定义导出与已发布版本
    ├── assets/<asset_id>/
    │   ├── original/<filename>      # 原始资料，不覆盖
    │   ├── extracted/              # 解析正文/页面/索引；带解析器版本
    │   └── manifest.json           # 来源、类型、摘要、hash、用途
    ├── employees/<employee_id>/
    │   ├── draft/                  # 员工工程可编辑草稿
    │   └── versions/<version>/     # 不可变员工定义和工程快照
    ├── planning/
    │   ├── workspace/              # 项目助手 Codex 会话 cwd
    │   ├── sessions.json           # threadId 等引用，不放凭据
    │   └── changes/<change_id>/    # 调优输入引用、变更与验证记录
    ├── tasks/<task_id>/
    │   ├── task.json               # 任务定义导出
    │   └── runs/<run_id>/
    │       ├── manifest.json       # 状态、任务/流程/员工版本、父运行
    │       ├── inputs/             # 固定输入快照或带 hash 的资产引用
    │       ├── workspace/          # 本次任务共享工程，由写入租约协调
    │       ├── executions/<execution_id>/
    │       │   ├── manifest.json   # employee_id、node_id、attempt、状态
    │       │   ├── inputs/         # 当前员工实际收到的数据/上游产物
    │       │   ├── workspace/      # 默认员工 cwd，私有可写执行副本
    │       │   ├── outputs/        # 员工产物，完成后封存并登记
    │       │   └── logs/           # 事件、stdout/stderr、调用元数据
    │       ├── handoffs/           # 产物引用、交接、人工问题与答复
    │       ├── outputs/            # 本次运行最终交付与验收结果
    │       ├── review/             # 人工修改副本，不改原始执行产物
    │       └── logs/               # 调度和整次运行的事件
    └── exports/                    # 按需导出，包含独立恢复所需文件
```

目录名使用稳定 ID，名称作为展示元数据，重命名不移动目录。一个 employee 可对应多个 execution，例如同一员工在不同节点工作或失败重试。人工员工不需要伪造模型工作目录，问题、答复和审批作为可追溯交接记录保存。

## 5. 三种场景

### 项目调优

上传资料进入 assets，同时记录本条聊天的附件关联。资料的“用于调优”“用于任务”是用途引用，不重复保存。项目助手以 planning/workspace 为 cwd，按需从 MCP 获取资料和员工配置；长文档提供索引与分段读取，不默认把全文反复塞入每轮。

修改员工草稿后产生新版本；试运行用内部验证任务的独立 run，避免把调优临时文件混进长期员工工程。旧运行继续引用其启动时固定的版本，调优不能改变已运行任务的证据。

### 任务运行

启动前固定任务定义、工作流、员工版本和资料 hash，建立新 run，再调度员工执行。每次重新运行产生新目录；resume_run_id 只表达继承关系，不能回写父运行。若只是进程中断恢复同一次 run，保留 run_id 并记录新的执行尝试，通过检查点决定恢复位置。

未发布最终产物不自动成为项目资料。用户确认采纳后登记新的资产版本，让后续任务显式引用，避免项目资产区成为运行垃圾桶。

### 员工执行与交接

默认把本节点需要的输入、工程版本及上游输出拷贝/受控引用到 execution.inputs，员工仅写自己的 workspace。执行结束登记 outputs 的 artifact_id、hash、生成者和验收信息，交接方通过引用取用。

同一代码工程不能由多位员工无协调地同时修改：顺序节点可持有 run.workspace 的独占写入租约；并行开发用独立工作副本或 Git worktree，合并前校验基础版本与冲突。同一个目录不等于允许并发任意写入。

长久记忆只保存显式审核的笔记/经验版本；不把每次运行的临时文件自动提升为员工记忆。共享技能和项目专属资料分别管理。

## 6. 组件与数据职责

| 组件 | 职责 |
| --- | --- |
| WorkspaceManager | 唯一目录解析入口；创建项目/run/execution 根，验证归属和相对路径 |
| AssetStore | 上传、解析、版本、hash；统一聊天附件与参考资料引用 |
| EmployeeVersionStore | 草稿编辑、发布版本、运行快照，不允许运行覆盖定义 |
| RunCoordinator | 固定输入、调度、重试、工作区写入租约、交接与人工等待 |
| ExecutionContext | 为执行器传入 project/task/run/execution ID、cwd、允许读取的输入和输出目录 |
| ArtifactStore | 登记产物与来源关系，生成最终交付与可编辑 review 副本 |
| CodexSessionManager | 会话与项目/执行实例绑定、恢复和显式 cwd；继承当前按项目复用策略 |
| Workspace API / MCP | 按业务 ID 查询目录/资料/产物、读取与受控写入；不接受模型任意绝对路径 |

数据库是状态、归属、版本和调度关系的权威来源；文件系统是文档/工程/产物字节的权威来源。project.json/task.json 等为可重建导出，不能与数据库自由双向覆盖。外部编辑草稿需通过保存/导入流程核验基础版本并更新 hash，运行只消费已确认版本。

新增或补充 WorkspaceLocation、Asset、EmployeeVersion、Execution、Artifact、Handoff 记录；现有 TaskRun/Evaluation 逐步映射到统一 Run。存储相对路径与 root 标识，不把当前机器绝对路径写成唯一身份。

文件先写 staging 临时位置，校验 hash 后原子发布；数据库记录 pending/ready，事务失败留下可识别的待清理孤儿，恢复程序处理未完成发布。不得宣称一次数据库提交能够同时原子提交整个文件目录。

## 7. Codex 目录设计

项目助手继续每项目一个持久会话，cwd 改为该项目 planning/workspace；员工执行默认以 execution.workspace 作为 cwd。员工会话按执行实例隔离，重试可在明确检查点继续；不把项目助手会话直接复用为所有员工的执行会话。

app-server 可以继续常驻复用，服务进程 cwd 与业务会话 cwd 分离。MCP 通过 ExecutionContext 定位资源。cwd 只是运行位置，沙箱允许目录、API 归属校验与写权限仍须单独设置。

旧会话恢复不能只改新建 thread 的路径；需先验证当前协议是否支持恢复时调整 cwd，以及技能/config 是否重新生效。优先保留旧会话并验证切换，若不支持则显式记录会话迁移和历史导入策略，不静默丢失上下文。

Codex 自身会话库先继续由其原存储管理，仅在项目保存引用和业务聊天导出。项目备份可以恢复业务，但跨机器直接恢复原 thread 依赖 Codex 会话库与登录环境；否则使用已导出的业务历史建立新会话并明确标记。

## 8. 实施顺序与验收

1. 引入目录解析层和项目根：数据库 ID 不变，新文件统一走 WorkspaceManager，旧路径仍可读。
2. 统一资料和员工工程：迁移附件二进制/源码到 assets，生成员工工程版本。备份后复制与校验，不直接移动删除。
3. 接入统一 run/execution：先改现有单员工与交付执行器，再把固定角色映射改成真实 employee_id + node_id。网页编辑器打开 workspace/review。
4. 项目助手切换独立 cwd：验证重启恢复、跨项目隔离、上下文与资料读取，保留回滚路径。
5. 补导出/恢复与清理：运行保留策略、活动运行保护、资产引用检查，确认恢复成功后再清理旧目录。

迁移必须覆盖数据库内 result.workspace/resume_workspace 等绝对路径、已有编辑副本及其人工修改。建立 old→new 映射，核验数量/hash、恢复链接、只读历史和原版本引用；新旧路径并存时明确优先级，禁止复制后各自写入造成分叉。

验收至少包括：两个项目无串读写；同任务两次运行目录独立；同员工两次执行数据不覆盖；旧运行保持原员工版本；上游产物可追溯；人工编辑不改原始证据；断点恢复与重试可区分；并发工程写入受控；符号链接/路径越界被拒绝；附件解析失败可见；项目导出恢复包含真实文件；Codex 会话恢复验证 cwd 和历史。

## 9. 代码依据

- `backend/app/config.py`：数据根与数据库配置。
- `backend/app/models.py`、`service.py`、`chat_attachments.py`：逻辑项目、员工工程、附件当前存储。
- `backend/app/tasks.py`：任务/运行关联与续跑链。
- `backend/app/evidence.py`、`employee_builder.py`、`delivery.py`：现有业务运行目录与执行 cwd。
- `backend/app/process_archive.py`、`output_workspace.py`：固定角色归档及人工可编辑副本。
- `backend/app/codex_session.py`、`runtime.py`：app-server、thread cwd、临时结构化调用与 MCP cwd。
