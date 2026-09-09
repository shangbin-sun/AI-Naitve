# Orbit 源码阅读与 AI 项目工厂产品决策

日期：2026-09-07。范围：当前工作区 `orbit-main` 快照。本文是源码审阅及产品推导，不是运行验收或全面安全审计。

## 1. 结论

保留一个 AI 项目工厂，内置具备独立开发生命周期的员工工厂。不需要因员工拥有代码、部署需求或外部依赖，就拆成第二个产品。

需要独立的是：员工工程、版本、调试工作区、试运行数据、发布门槛和执行环境。登录、资产管理、项目知识、权限、消息、成果及审计应共享。Worker 可单独部署，员工源码也可独立仓库，不要求与平台源码放在一起。

Orbit 的主要启发是“可编辑、可装配、可运行的工作方案”。它本身包含配置开发和任务运行，证明两类体验可以共存；它尚未证明成熟的员工资产开发、独立员工身份与项目协作已经实现。

## 2. 阅读范围与依据

已阅读 README、原始 task.md、核心类型与数据库模型、配置包导入导出、AI 配置生成、配置 CRUD、Planner、StepProcessor、调度器、适配器、工作区存储、Git 成果记录、人工工单、鉴权、事件与 Worker 链路，以及配置页、流程画布、任务页和人工表单的实现。查阅了 schema.md、内置流程样例及 pipline.zip 的条目结构。

没有启动 Orbit 服务、安装依赖、调用其模型服务或触发 Webhook。样例中存在外部通知地址，本次未调用，也未复制到新定义。未发现常规测试文件及测试脚本；不将“源码存在”表述为“运行验证通过”。项目原 task.md 是研究材料，其中的技术偏好不覆盖用户已经确定的 Python 后端选择。

| 主题 | 源码证据 | 实际含义 |
|---|---|---|
| 配置对象 | [types.ts](/Users/bingo/Desktop/code/ai_native/orbit-main/packages/core/src/types.ts:138) | Step 嵌在 Phase 中，Bundle 聚合 Planner、MCP、Skills 和 Phase |
| 数据组织 | [schema.ts](/Users/bingo/Desktop/code/ai_native/orbit-main/packages/db/src/schema.ts:68) | Bundle 与运行关联，未建模独立 Employee／EmployeeVersion |
| AI 开发草稿 | [bundle-ai.processor.ts](/Users/bingo/Desktop/code/ai_native/orbit-main/apps/api/src/bundle-ai.processor.ts:125) | 在临时目录生成 config.yaml 与 Skills，再解析写回数据库 |
| 发布 | [bundle-ai.controller.ts](/Users/bingo/Desktop/code/ai_native/orbit-main/apps/api/src/bundle-ai.controller.ts:118) | 检查生成状态和 Phase 存在后改变发布状态 |
| 包格式与校验 | [bundle-zip.ts](/Users/bingo/Desktop/code/ai_native/orbit-main/packages/core/src/bundle-zip.ts:147) | 校验部分引用，支持新 YAML 包和旧目录包 |
| 规划 | [plan.ts](/Users/bingo/Desktop/code/ai_native/orbit-main/packages/core/src/plan.ts:5) | 从已有 Phase 中选择有序路径，并给出原因 |
| 调度 | [scheduler.service.ts](/Users/bingo/Desktop/code/ai_native/orbit-main/apps/api/src/scheduler.service.ts:452) | 顺序推进、显式跳转和有限重试，不是通用并行 DAG 引擎 |
| 人工确认后执行 | [processors.ts](/Users/bingo/Desktop/code/ai_native/orbit-main/apps/api/src/processors.ts:452) | 将表单与意见传给后续执行，使确认影响文件产物 |
| 评审返工 | [processors.ts](/Users/bingo/Desktop/code/ai_native/orbit-main/apps/api/src/processors.ts:604) | 解析 success/fail，失败可回到指定步骤 |
| 上下文绑定 | [interpolate.ts](/Users/bingo/Desktop/code/ai_native/orbit-main/packages/core/src/interpolate.ts:12) | 支持任务、人工意见和评审原因等插值 |
| 成果版本 | [artifacts-git.ts](/Users/bingo/Desktop/code/ai_native/orbit-main/apps/api/src/artifacts-git.ts:32) | 对 artifacts 目录提交 Git，并在事件中附提交信息 |
| 执行视图 | [TaskCanvas.tsx](/Users/bingo/Desktop/code/ai_native/orbit-main/apps/web/src/pages/TaskCanvas.tsx:666) | 流程、节点输入输出、文件、日志和需求入口同页联动 |

## 3. 是否独立建设员工工厂

| 选择 | 优点 | 代价 | 判断 |
|---|---|---|---|
| 两个独立平台 | 独立团队、客户和发布节奏 | 认证、资产同步、资源、回传和权限都需跨平台协调 | 目前没有业务证据证明值得 |
| 同一平台的独立开发子系统 | 开发体验完整，复用平台基础服务 | 必须认真隔离开发状态和正式运行 | 推荐 |
| 仅增加员工配置表单 | 初期工作量小 | 无法承载代码、工具、调试、评测和依赖 | 不满足用户需求 |

未来出现独立客户购买员工资产、多种上层项目平台接入、独立团队发布／运营或基础设施边界要求时，再评估产品拆分。当前先提供版本化资产契约、导入导出和 Runtime 接口，保留拆分能力。

## 4. 必须修正的概念组织

- 员工工程：开发能力的源工程，可含配置、指令、Skills、脚本、工具、依赖及测试样例。
- 员工模板版本：员工工程通过评测后发布的能力资产；“模板”和“正式资产”是同一对象的复用语义。
- 工作流程定义：描述工作节点、输入输出与控制关系。作为员工内部实现，或作为项目协作方案使用，但必须标明作用域。
- 项目模板：目标输入、岗位、默认员工版本、协作流程、资源需求、人工决策点和验收要求。
- 具体项目：固定模板快照，绑定人员、员工实例、资源和数据。
- 运行：执行某个确定版本；每次重试／返工有独立记录。

流程节点是工作，员工是执行者；一个员工可承担多个节点。人类任务、人工批准、自动检查、工具调用和 AI 工作不应全部编码成“员工角色”。

## 5. 吸收优点及改进落点

| Orbit 优点 | 产品扩充 | 优先级 |
|---|---|---|
| 多轮 AI 生成配置草稿 | 在员工开发工作台中对源工程提出可审查修改，保留差异、校验及调试记录 | P1；P0 保证手动开发完整 |
| 可装配 Phase／Step | 增加工作流程定义与节点输入输出；支持员工内部和项目协作两种作用域 | P0 最小流程 |
| 配置表单和文件包 | 一个规范化定义支持表单及源码编辑，提交校验，导入导出 | P0 基础能力 |
| Planner 选择路径并说明理由 | 支持从项目模板候选阶段生成计划版本，展示依赖和选择依据 | P0 |
| Human 表单 | 结构化问题与答案，服务端验证，绑定具体版本和负责人 | P0 |
| 确认后再次写入 | 区分提案、决定、应用结果；只批准无需修改时直接通过，避免重复执行 | P0 |
| Review 失败返回执行 | 结构化评审、不符合格式与业务失败分开；显式返工轮次与预算 | P0 |
| 插值目录 | 类型化输入绑定、缺失检查、最终上下文预览与来源追踪 | P0 |
| 流程／文件／日志联动 | 开发时看节点调试，项目中看协作进展；支持展开员工内部子流程 | P0 查看；复杂可视化编辑 P1 |
| intent.md 更新记录 | 平台需求版本生成可读文件视图，文件修改通过变更提交回写 | P0 |
| artifacts Git | 文本成果支持差异，大文件用哈希与对象存储版本，统一成果身份 | P0 |
| 人工等待独立计时 | 区分总耗时、执行、排队、外部作业与人工等待 | P0 |
| Webhook 工单提醒 | 消息渠道可插拔，回执与身份、权限、到期规则结合 | P1 |

## 6. 不能当作已完成能力直接继承的部分

### 6.1 MCP 配置未贯通执行

MCP 的存储、页面和引用字段存在，但 `loadBundleGraph` 只加载 Skills 等对象，StepProcessor 调用适配器也未传 MCP；AdapterRunInput 未包含 MCP 实例。见 [scheduler.service.ts:420](/Users/bingo/Desktop/code/ai_native/orbit-main/apps/api/src/scheduler.service.ts:420)、[processors.ts:517](/Users/bingo/Desktop/code/ai_native/orbit-main/apps/api/src/processors.ts:517)。

要求：连接声明、资源绑定、实际工具发现、授权调用和就绪检查必须贯通，测试需要证明员工确实调用了指定工具。

### 6.2 Workspace 目录不构成执行隔离

`runCommand` 使用宿主 shell 和继承环境，CLI 也直接 spawn；`sandboxCommand` 存在但源码搜索没有发现调用点。词法路径检查也不能完整处理符号链接边界。见 [shared.ts:170](/Users/bingo/Desktop/code/ai_native/orbit-main/packages/adapters/src/shared.ts:170)、[sandbox.ts:4](/Users/bingo/Desktop/code/ai_native/orbit-main/apps/api/src/sandbox.ts:4)、[claude-code.ts:140](/Users/bingo/Desktop/code/ai_native/orbit-main/packages/adapters/src/claude-code.ts:140)。

要求：真实环境隔离；开发沙箱与正式项目环境分别绑定资源，不使用提示词约束代替执行边界。

### 6.3 超时／取消不等于进程停止

适配器的 `withTimeout` 仅 Promise.race；取消任务主要更新状态并清理排队任务，没有传递到活跃 CLI 的取消句柄。执行返回后还有写文件和更新状态路径。见 [shared.ts:298](/Users/bingo/Desktop/code/ai_native/orbit-main/packages/adapters/src/shared.ts:298)、[scheduler.service.ts:677](/Users/bingo/Desktop/code/ai_native/orbit-main/apps/api/src/scheduler.service.ts:677)。

要求：可取消执行句柄、停止回执、写入租约失效和迟到结果拒收；外部作业独立处理。

### 6.4 发布状态不等于不可变版本

已发布配置仍可经 CRUD 更新，运行时重新加载当前 Bundle。AI 应用配置会删除并重建 Phase／Skills／MCP，未看到不可变发布快照。见 [bundle-apply.ts:17](/Users/bingo/Desktop/code/ai_native/orbit-main/apps/api/src/bundle-apply.ts:17)、[bundles.controller.ts:485](/Users/bingo/Desktop/code/ai_native/orbit-main/apps/api/src/bundles.controller.ts:485)。

要求：开发草稿、发布版本和项目实例分开；发布锁定依赖；旧运行始终使用旧版本。

### 6.5 顺序上下文不足以支撑团队协作

当前 `prev.output` 取整个任务最近成功 Step，未根据显式输入边选择；`findNext` 是顺序和跳转。适配器也没有平台员工身份及通信对象。

要求：节点显式引用输入成果，支持多上游；组织层有员工身份和交接消息，不能以“上一条输出”代替协作协议。

### 6.6 重规划有状态互斥风险

`continueAfterStep` 请求重规划时没有先结束 active run，而 PlanProcessor 发现 active run 后会丢弃计划；从代码路径看，更新需求后可能停在重规划。未运行复现。见 [scheduler.service.ts:513](/Users/bingo/Desktop/code/ai_native/orbit-main/apps/api/src/scheduler.service.ts:513)、[processors.ts:162](/Users/bingo/Desktop/code/ai_native/orbit-main/apps/api/src/processors.ts:162)。

要求：新计划版本与旧运行的暂停／替代须原子协调，覆盖“当前步骤结束后重规划”的验收。

### 6.7 人工确认需要更严格的语义

Orbit human 节点是“AI 先执行→人确认→AI 再写入”，不是真正的人类承担任务。拒绝但没有跳转目标时存在将 stepRun 标为 success 并推进下一步的路径。见 [scheduler.service.ts:938](/Users/bingo/Desktop/code/ai_native/orbit-main/apps/api/src/scheduler.service.ts:938)。

要求：人类任务与批准节点分开；拒绝必须进入退回、暂停或终止；批准后的变更不能偷偷改变被批准的版本。

### 6.8 其他需独立落实的基础能力

- WebSocket watch 有登录检查，但订阅时未检查 taskId 的租户归属：[runs.gateway.ts:62](/Users/bingo/Desktop/code/ai_native/orbit-main/apps/api/src/runs.gateway.ts:62)。新平台需对象级订阅权限。
- Storage 声明 s3 driver，但文件方法仍是本地 fs。不能将 compose 中有 MinIO 理解为 S3 已接入。
- AI 草稿临时目录结束后删除，无法承载长期员工源工程、断点和完整评测资产。
- Flow 的 `nodesConnectable={false}` 表明它主要是查看器，不是任意流程编排编辑器。
- 包可包含 llm.apiKey／MCP env 等配置。新格式只导出资源需求和凭据引用，不带实际密钥。
- 标准无工具 chat 适配器不能履行读文件指令；新平台需能力兼容检查。

## 7. 文档更新

本次新增独立员工开发工程、员工能力入口、工作流程作用域、项目模板及依赖锁定、资源就绪检查、受控试运行、结构化人工表单和评审返工。

已合并到 [产品定义 v0.2](/Users/bingo/Desktop/code/ai_native/docs/ai-project-factory-product-spec-v0.2.md)。v0.1 保留为历史讨论稿；新增范围仍需用户确认，不表示代码已实现。
