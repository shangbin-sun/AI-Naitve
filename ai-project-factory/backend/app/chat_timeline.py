"""Lossless public-item projection. Never expose reasoning or invent turns."""
import json


def project_turns(thread_id, turns, dispatch_turns=()):
    messages, warnings = [], []
    tools = {'commandExecution': '执行命令', 'fileChange': '文件变更',
             'mcpToolCall': '工具调用', 'dynamicToolCall': '工具调用',
             'collabAgentToolCall': '员工调度', 'webSearch': '搜索',
             'imageView': '查看图片', 'imageGeneration': '生成图片'}
    for turn in turns:
        tid = turn.get('id', '')
        if turn.get('itemsView') in ('summary', 'notLoaded'):
            warnings.append('部分轮次未返回完整内容，请重试读取。')
        if turn.get('error'):
            warnings.append('有轮次执行失败；以下仅显示实际保存的记录。')
        for index, item in enumerate(turn.get('items', [])):
            if item.get('truncated') or item.get('outputTruncated'):
                warnings.append('部分执行输出在来源中已被截断；这里只显示实际保存的内容。')
            kind = item.get('type')
            row = {'id': f"native-{thread_id}-{tid}-{item.get('id', index)}", 'turn_id': tid,
                   'role': 'assistant', 'content': ''}
            if kind == 'reasoning':
                continue
            if kind == 'userMessage':
                row['role'] = 'user'
                parts = item.get('content', [])
                row['content'] = '\n'.join(p.get('text', '') if p.get('type') == 'text'
                    else '[附件记录] ' + str(p.get('path') or p.get('url') or p.get('type')) for p in parts)
                row['content'] = row['content'] or item.get('text', '')
                if tid in dispatch_turns:
                    row['source_label'] = '任务派工'
            elif kind == 'agentMessage':
                row['content'] = item.get('text', '')
                try:
                    report = json.loads(row['content'])
                    if isinstance(report, dict) and set(report) == {'summary', 'verification', 'artifacts'}:
                        row['content'] = report['summary'] + '\n\n验证：' + report['verification']
                        row['content'] += '\n\n产物：\n' + '\n'.join('- ' + name for name in report['artifacts'])
                except (ValueError, TypeError):
                    pass
            elif kind in tools:
                row['event'] = {'title': tools[kind], 'status': item.get('status', turn.get('status', '')),
                    'detail': json.dumps(item, ensure_ascii=False, indent=2)}
            elif kind == 'contextCompaction':
                warnings.append('会话存在上下文压缩；这里只展示接口仍保留的公开记录，不补写缺失内容。')
                continue
            else:
                warnings.append(f'存在尚未支持显示的事件类型：{kind}；未将其伪装成聊天消息。')
                continue
            if row['content'] or row.get('event'):
                messages.append(row)
    return messages, list(dict.fromkeys(warnings))
