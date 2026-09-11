"""Read-only, bounded projections of observable Agent activity."""
import asyncio
from fastapi import HTTPException
from .codex_session import CodexConnection


def activity_items(thread):
    result = []
    # Reasoning, hidden context and user inputs are deliberately not projected.
    for turn in thread.get('turns', [])[-20:]:
        for item in turn.get('items', []):
            kind = item.get('type')
            text = ''
            if kind == 'agentMessage':
                title, text = '输出', item.get('text', '')
            elif kind == 'commandExecution':
                title, text = '执行命令', item.get('aggregatedOutput', '')
            elif kind == 'mcpToolCall':
                title = '调用工具 · ' + str(item.get('tool', ''))
            elif kind == 'dynamicToolCall':
                title = '更新执行状态 · ' + str(item.get('tool', ''))
            elif kind == 'fileChange':
                title = '更新文件'
                text = '\n'.join(str(change.get('path', '')).rsplit('/', 1)[-1] for change in item.get('changes', []))
            elif kind == 'collabAgentToolCall':
                title = '员工调度 · ' + str(item.get('tool', ''))
            elif kind == 'subAgentActivity':
                title = '员工活动 · ' + str(item.get('kind', ''))
            else:
                continue
            result.append({'id': str(item.get('id', len(result))), 'title': title,
                           'status': item.get('status') or ('completed' if turn.get('status') == 'completed' else 'inProgress'),
                           'text': str(text or '')[-4000:]})
    return result[-100:]


def install_run_activity(app, manager):
    @app.get('/api/workspaces/{project}/agent-runs/{run_id}/activity')
    async def activity(project: str, run_id: str, node: str | None = None, tuning: bool = False):
        with manager.sessions() as db:
            _, run = manager.rows(db, project, run_id)
            current = run.state.get('nodes', {}).get(node) if node is not None else None
            if node is not None and current is None:
                raise HTTPException(404, '员工节点不存在')
            if tuning and current and current.get('tuning'):
                current = current['tuning']
            thread_id = current.get('thread_id') if current else run.thread_id
            result = {'status': current['status'] if current else run.status,
                      'activity': current.get('activity', '') if current else '', 'items': []}
        if not thread_id:
            result['activity'] = result['activity'] or '等待会话启动'
            return result
        connection = manager.connections.get(run_id)
        owned = connection is None
        if owned:
            connection = CodexConnection(manager.settings)
        try:
            async def read():
                await connection.ensure()
                return await connection.rpc('thread/read', {'threadId': thread_id, 'includeTurns': True})
            history = await asyncio.wait_for(read(), timeout=10)
            result['items'] = activity_items(history.get('thread', {}))
            return result
        except (Exception, asyncio.TimeoutError) as exc:
            raise HTTPException(503, '运行过程暂时无法读取，请稍后刷新；任务执行不受影响') from exc
        finally:
            if owned:
                await connection.close()
