# AI 团队自动编程看板

本功能对应“页面和配置随项目保存”的看板，不是聊天记忆管理器。团队内新增独立“看板”页，点击生成或调整会在现有团队对话填入请求，用户发送后由 Codex 编写并通过 MCP 保存页面。

## 产品与编辑边界

- 看板保存 HTML、CSS、JavaScript、JSON Schema、样例数据与数据绑定，拥有独立版本。调整看板不修改团队定义版本、员工、规则、技能或工作流；现有编辑入口继续使用原接口。
- 配置预览明确标为样例数据，可选择历史看板版本。选择运行时展示该运行冻结的版本与实际数据；没有看板快照的旧运行明确提示不支持，不套用新版本冒充历史结果。
- 支持图表、列表、筛选等页面内交互。本期不支持业务写操作、联网资源、外部 CDN、任意文件读取、包安装和构建服务。框架代码需预先打包为静态文件。

## 存储与数据

数据库 `dashboards` 保存当前版本，`dashboard_revisions` 保存历史页面包，均按项目隔离。MCP `get_dashboard` 提供源码和保存契约，`save_dashboard` 使用 expected_version 与 request_id 检查并发和重试。页面版本进入运行 definition 的内容哈希，并投影到冻结目录的 `dashboard/`，其中 `manifest.json` 保存配置。

网页从 `window.DASHBOARD_DATA` 读取数据：

1. 配置预览：已通过 schema 验证的 sample_data。
2. 运行摘要：`{run: {id, title, status}, nodes: [{key, name, employee, status, artifacts}]}`。
3. 自定义成果：指定 data_node（工作流节点 key）与 data_file（JSON 文件名），只读取该节点已登记的唯一产物，校验范围、大小、哈希与 schema。缺失或不匹配显示错误，不回退样例。看板不会自动修改员工职责以新增产物；需要新增业务产物时通过现有员工配置流程明确处理。

包必须包含 index.html，最多 20 个 HTML/CSS/JS 文件，总计不超过 1 MB；schema 最大 100 KB，样例和实际 JSON 数据最大 1 MB。schema 只支持内部引用，验证器禁止远程检索。

## 浏览器隔离与验收

预览采用两层 iframe。生成页面只有 allow-scripts，不开放 allow-same-origin；nonce CSP 禁止网络连接、表单和嵌套页面，外层 frame-src 限制页面自身导航。数据注入转义 HTML 结束标签，静态脚本和样式内联编译，不调用现有文件编辑接口。

相关浏览器行为依据：[MDN iframe](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)、[MDN CSP sandbox](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/sandbox)。

测试覆盖独立版本、MCP 幂等、员工编辑兼容、运行版本冻结、自定义产物哈希、无效 schema/页面、数据转义及前端入口。`test_dashboard_browser.py` 使用真实 Chromium 验证脚本与数据正常运行，跨框架 DOM、网络访问及外部导航受阻；默认跳过，指定 DASHBOARD_CHROME 并安装 playwright 后执行。模型生成页面质量尚未做真实 Codex 业务验收，工具接入测试不代表模型内容验收。
