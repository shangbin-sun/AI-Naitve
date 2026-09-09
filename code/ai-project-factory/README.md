# AI 项目工厂

一个 AI 项目工厂，内置员工工程开发能力。当前完成项目筹备阶段：**创建项目 → 项目内对话与方案 → 编辑员工 → 保留修订和方案快照**。全局仅“项目”和“员工”两个入口，默认项目，员工入口弱化。

## 启动

需要 Python 3.11+、Node.js 20.19+（或 22.12+）、已安装并登录的 Codex CLI。

```bash
cd code/ai-project-factory
bash scripts/setup.sh
backend/.venv/bin/python scripts/dev.py
```

打开 http://127.0.0.1:5173。接口文档：http://127.0.0.1:8000/docs。Ctrl+C 停止两个服务。
安装一次后直接运行最后一条命令。可用 `PYTHON=/path/to/python3 bash scripts/setup.sh` 选择 Python。

Codex 连接使用本机 `codex exec`，继承当前系统用户的 CLI 登录状态。生成团队会实际调用模型并消耗账户额度；登录凭据不复制进项目。运行时使用临时目录、只读沙箱、结构化 JSON 输出，忽略个人项目配置，后台持久化任务状态。模型推理使用 Codex 服务；聊天内容和团队草稿会随请求发送。本地数据默认保存在 `.data/factory.db`。

## 本次已实现

- 聊天创建和迭代团队方案，持续保存对话、生成状态、用量与修订历史。
- AI / 人类岗位、工作流依赖、输入输出、验收条件、资源缺口和待确认问题。
- 生成方案成员时同步建立可编辑员工工程：岗位指令、README、评测样例。
- 员工职责及虚拟工程文件编辑、ZIP 导出；员工配置与团队方案同步。
- 草稿版本校验：人工修改后，迟到的生成结果标记冲突并保留，不覆盖修改。
- 相同请求幂等、运行取消、超时处理、服务重启后标记中断。
- 在同一持续项目内保存不可变方案快照；后续修改只更新当前方案，不改历史内容。
- 项目列表搜索；概览、对话、方案和历史全宽切换；项目与员工详情 URL 恢复，未保存修改保护。
- API `/api/workspaces` 表示持续项目，`/api/snapshots` 表示历史方案；复用原表和 ID，旧接口继续兼容。
- 项目内“资料与评估”：参考资料版本、来源链接、节选范围和哈希；导入 `Agent项目` 下的选定源码快照。
- 独立设计评估，固定12类检查并区分通过、不通过、阻塞、未评估；结果绑定方案、员工及资料版本，可带回项目对话继续优化。
- 需求员工试运行：当前要求员工key为 `requirements`，实际生成需求、感知契约、执行契约、模型需求、疑问和追溯六个文件。文件保存在 `.data/analyses/<运行ID>`，内容和哈希可在平台查看；仍需独立验收。
- 隔离副本全模块Gradle基线测试：处理脚本CRLF、复用已有发行包缓存、保留日志与退出码、超时终止。默认离线解析依赖，也可显式允许下载构建依赖。不会调用publish；源码自身的构建脚本仍在本机执行，这不是容器隔离。

验证见 [项目中心改版验收](reports/project-workspace-regression.md) 和 [Agent基线迭代记录](reports/agent-baseline-iteration.md)。目前有需求文档试运行和基线测试，任意员工工具执行、完整DAG调度、E2E和部署执行尚未接入。

## 目录与架构

```text
backend/app/
  main.py       HTTP API
  schemas.py    团队定义与工作流约束
  models.py     设计、消息、任务、员工、修订、项目
  service.py    员工工程生成、版本控制、项目快照
  jobs.py       本地异步调度与任务恢复
  runtime.py    Codex CLI 适配器
  evidence.py   资料版本、独立评估、需求试运行、Gradle基线测试
frontend/src/   React + TypeScript + Ant Design
scripts/        安装和本地启动
```

后端为 FastAPI / SQLAlchemy，默认 SQLite，无需 Docker；可用 `DATABASE_URL` 连接已有 PostgreSQL。配置见 `.env.example`，通过环境变量设置。前端 Vite 代理 `/api` 到 Python。团队设计、员工工程、项目快照分别建模，给后续模板发布和实际执行保留边界。

## 验证

```bash
cd backend
.venv/bin/pytest
cd ../frontend
npm test
npm run build
```

## 当前边界与下一步

这是单机、单用户、单 Python 进程的开发版，仅监听本机。尚未提供身份权限、分布式队列、数据库迁移、云端 VS Code、正式员工评测发布、实际工作流执行、训练或部署。不能直接以多 worker 或公网方式部署。

员工文件当前作为服务端数据库中的虚拟工程持久化，可编辑与导出；尚未挂载为员工运行容器内的真实目录。修改工程不会执行其中代码。项目创建只保存快照，不启动任务。需求试运行会将当前员工工程作为模型输入；参考资料和代码节选也会随设计、评估请求发送给Codex。

`FACTORY_SOURCE_ROOT` 可设置允许导入的资料根目录，默认仓库下的 `Agent项目`。源码导入排除隐藏目录、构建产物和配置文件，仅包含选定源码/文档/Wrapper；不是完整备份。评估保留输入快照，后续资料更新不会改变旧结论。平台只有单用户本地权限边界；请勿对公网开放本机命令执行接口。

下一里程碑：员工试运行沙箱、工具/资源绑定、评测结果和版本发布；然后接项目运行、人工干预及数据交接。产品完整需求位于仓库 `docs/ai-project-factory-product-spec-v0.3.md`，本实现不代表全部需求已完成。

网页版 VS Code 已接入员工产出卡片。安装 `code-server` 后，`python3 scripts/dev.py` 会同时启动三个服务；已有前后端运行时可单独执行 `python3 scripts/editor.py`。详见 [网页编辑器说明](docs-web-editor.md)。
