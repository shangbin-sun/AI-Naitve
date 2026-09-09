# 项目工具与员工优化

项目对话继续使用持久 Codex thread。用户原文保持不变，额外的界面上下文只包含当前项目版本和可选员工引用；完整配置、工作流、资料和运行记录由 MCP 按需查询。

## 使用

- 员工详情点击“讨论／优化此员工”，回到项目聊天并选择该员工；未保存编辑需要先保存。
- 普通聊天由 Codex 根据自然语言和项目数据判断目标员工，有歧义时再询问。从员工详情进入时显示可移除的引用标签，发送后引用随历史消息保存。
- 可以要求生成团队、修改指定员工的职责/提示词/工程文件、读取历史运行，或使用样例测试。
- 生成团队自动同步 AI 员工工程草稿。工程草稿不等于已构建可执行员工。员工试运行要求已有 `employee.py`，输入遵循现有 JSON 协议。
- 提供 expected_json 时实际输出进行 JSON 值比较；未提供时只报告运行输出，不能等同于业务验收。评估结果绑定员工版本与文件哈希。

## 实现

`app.project_mcp` 使用官方 Python MCP SDK 作为 STDIO 服务。每个 Codex 项目线程配置独立的项目ID和随机凭据，只连接当前应用的内置业务工具端点。凭据不进入用户文本；服务重启后重新生成并在 thread/resume 更新配置。

9 个工具：get_project_overview、get_employee、get_team_schema、get_source、list_runs、get_run、update_employee、apply_team_changes、evaluate_employee。

`skills/project-operations/SKILL.md` 由后端加载为稳定的线程指引，包含按需读取、保留无关对象、先基线后优化、同样例验证和证据要求；无需为读取此 Skill 开启 shell 工具或用户全局技能。此版本不是依赖 Codex 自动发现 Skill，而是应用显式加载该文件。

项目 MCP 的 9 个工具使用线程级明确允许列表；不修改用户全局 Codex 配置。内部端点要求项目专属凭据，且有对应活动 chat job；停止或计划生成分支不能写入。员工、资料、运行ID均检查项目归属。

员工修改复用 edit_employee、团队修改复用 apply_draft；检查员工和项目版本。团队工具拒绝隐式删除既有成员/节点。工具写入记录在 project_tool_operations 表，以项目、操作、request_id 去重；同一ID不同参数拒绝。新增 message_references 保存消息引用，两表均为增量创建。

工具开始/返回与写入结果进入当前 job 日志；页面收到对话结束事件刷新团队和员工。长试运行返回ID，可通过 get_run 等待最多20秒。取消聊天不撤销已提交修改，独立启动的员工评估仍以自己的运行记录为准。

## 验证

- 后端测试覆盖跨项目访问、无凭据访问、已停止对话、版本冲突、写入重试、团队同步与成员保留。
- 使用真实 Python 员工验证预期结果一致/不一致分支，并测试 MCP SDK 不改变 JSON 字符串参数。
- 前端验证关联员工选择、历史引用，浏览器验证员工详情跳转到对话且引用已选中。
- 独立测试库 `.data/mcp-probe` 验证真实 Codex 经 MCP 读取员工、建立基线、仅修改 employee.py 并保存，再次运行验证。测试项目未写入用户项目库。

最终验证：92 项后端测试、68 项前端测试通过，生产构建成功。真实 Codex 复验运行 `9fb26b809245440ca981efcafcc4faa3` 使用员工 v3、输入 {"value":3}、预期 {"value":6}，返回 completed 与 comparison.passed=true。生产库已备份后重启，三个本地服务均返回200。
