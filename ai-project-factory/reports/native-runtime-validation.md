# 主智能体运行改造验收记录

## 工作空间侧栏增量验收（2026-09-10）

项目聊天 cwd 调整为项目根目录；右侧浏览器与单节点/任务运行、追问的 cwd 绑定。新增目录浏览、文本预览、下载、跨项目/运行限制及预览切换测试。后端全量 112 项通过；最后的状态工具修改另通过 15 项定向回归。前端全量 77 项通过，生产构建通过。真实 Codex 追问复用原主会话，子会话集合不变且未重跑已完成节点。服务已备份重启，两个已有项目的目录接口实测成功，`..` 越界返回 403。

当前任务追问与本次运行共用会话、工作目录；项目根目录入口可查看所有任务，但运行入口不能跳到其他运行目录。

2026-09-10，本地 codex-cli 0.153.4。服务已重启，新运行接口和前端均返回 HTTP 200。

## 自动化回归

- `backend/.venv/bin/python -m pytest backend/tests -q`：110 通过。
- 前端 `npm test -- --run`：15 个文件、76 项测试通过。
- 前端 `npm run build`：通过；保留既有的大 bundle 提示。
- `git diff --check`：通过。

新增覆盖：定义/员工文件内容变更后快照隔离，两类任务目录对齐，request_id 内容冲突，前置依赖，真实子会话关联与伪造提交拒绝，文件及目录符号链接拒绝，跨项目读取拒绝，成果 hash 变更检测，人工答复与重复答复，取消、重启标记和原快照保留，项目 MCP 发起/查询运行，前端提交与重试幂等。原聊天、图片/文件、员工编辑、代码验证和历史运行测试仍通过。

## 实际 Codex 测试（独立临时数据库）

1. 单节点：主会话 `01a0891f-66b5-7ed2-ab4f-1c44026d95d4`，实际子会话 `01a0891f-ccd7-7303-8513-274cbb09131b`；产生 `result.txt`，内容核实为 `NATIVE_OK`，运行 completed。
2. 工作流：主会话 `01a08921-92de-7c43-8782-9b0f606031dc`，实际派生 4 个员工子会话。事件顺序验证 A 完成后启动 B，B 完成后并行派发 C/D，两者都完成后进入人工等待。4 份输出均核实为 `NATIVE_OK`。
3. 原会话恢复：上述工作流进入人工等待后关闭 App Server，写入测试人工答复，再通过新连接恢复同一主会话。最终 completed，主 ID 不变，子会话集合不变，没有重跑已完成节点。此真实测试用数据库注入人工答复；人工答复 HTTP 接口另外由自动化回归验证。
4. 取消：运行 `20260910T023016415809Z-run-734a248dea17` 在真实子会话派生后停止，状态 cancelled，连接进程已关闭，未登记完成产物。

初次真实测试发现本机主要使用 `subAgentActivity`，而不是只使用旧 `collabAgentToolCall` 上报原生子会话。已同时适配两种协议，并增加对应回归。上述成功结果均来自修复后的运行。

可复现命令：

```sh
PYTHONPATH=backend backend/.venv/bin/python scripts/probe_native_runs.py
PYTHONPATH=backend backend/.venv/bin/python scripts/probe_native_runs.py --workflow
PYTHONPATH=backend backend/.venv/bin/python scripts/probe_native_runs.py --cancel
```

## 数据兼容与服务

数据库备份：`.data/backups/before-native-runs-20260910T023312Z.sqlite`。重启前后 designs=2、employees=1、messages=38、evaluations=0，一致。只新增运行表，未移动或删除旧运行档案。现有项目访问新 agent-runs 接口成功。

## 使用边界

- 一个 run 的员工共享运行级沙箱；节点目录不是员工间的 OS 强隔离。
- 只验证本机 Codex 版本；后续 CLI 协议更新需重新运行原生探针。
- interrupted 不自动重放外部副作用；恢复原会话和冻结定义，不能承诺任意中断都能自动完成。
- 文件存在、hash 匹配与子会话完成证明执行事实，不自动证明业务质量；业务验收依据任务要求和人工反馈。
- 本轮前端验证为组件测试、生产构建和 HTTP 检查，未进行浏览器端视觉自动化。
