"""Host-bound Feishu accessibility bridge. No arbitrary scripts or coordinates."""
import asyncio
import hashlib
import json
import re
import sys
from pathlib import Path
from fastapi import HTTPException

SCRIPT = Path(__file__).parent / 'desktop/feishu.swift'


class FeishuDesktop:
    def __init__(self):
        self.lock = asyncio.Lock()
        self.states = {}

    async def execute(self, payload):
        if sys.platform != 'darwin':
            raise HTTPException(409, '桌面飞书工具只支持运行服务端的 Mac')
        process = await asyncio.create_subprocess_exec('/usr/bin/swift', str(SCRIPT),
            json.dumps(payload, ensure_ascii=False), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), 30)
        except asyncio.CancelledError:
            if process.returncode is None:
                process.kill()
            await process.communicate()
            raise
        except asyncio.TimeoutError:
            if process.returncode is None:
                process.kill()
            await process.communicate()
            raise HTTPException(409, '桌面操作未能确认完成；请检查飞书当前界面，不要直接重复发送')
        if process.returncode:
            error = (stdout + stderr).decode(errors='replace')
            if any(word in error for word in ('ACCESSIBILITY_REQUIRED', 'not allowed assistive', '不允许辅助', '-1719', '-1743')):
                raise HTTPException(409, '需要在系统设置 → 隐私与安全性中，为启动服务的 Codex/终端/Python 授予辅助功能及控制 System Events 的自动化权限')
            if 'FEISHU_NOT_FRONTMOST' in error:
                raise HTTPException(409, '飞书不是前台应用，请重新打开并读取界面')
            raise HTTPException(409, '飞书界面操作失败，请重新读取界面。' + error[:300])
        return json.loads(stdout)

    async def call(self, project, action, state_id='', element_id='', text='', key=''):
        if action not in ('status', 'open', 'inspect', 'press', 'set_text', 'key'):
            raise HTTPException(422, '未知飞书操作')
        async with self.lock:
            if action == 'status':
                result = await self.execute({'action': 'status'})
                result['ready'] = result['accessibility'] and result['running']
                if not result['accessibility']:
                    result['required_action'] = '在系统设置 → 隐私与安全性 → 辅助功能，授权启动服务的 Codex/终端/Python；若出现自动化弹窗，允许控制 System Events。'
                return result
            if action == 'open':
                self.states.clear()
                return await self.execute({'action': action})
            current = await self.execute({'action': 'inspect'})
            digest = hashlib.sha256(json.dumps(current, sort_keys=True).encode()).hexdigest()
            if action == 'inspect':
                self.states[project] = digest
                return {**current, 'state_id': digest}
            if not state_id or self.states.get(project) != state_id or digest != state_id:
                raise HTTPException(409, '界面已变化或缺少本AI 团队观察结果，必须重新 inspect 后再操作')
            if action in ('press', 'set_text'):
                if not re.fullmatch(r'\d+(?:/\d+)*', element_id) or element_id not in {n['id'] for n in current['nodes']}:
                    raise HTTPException(422, '必须使用本次界面返回的 element_id')
            if action == 'set_text' and (not isinstance(text, str) or not 1 <= len(text) <= 10000):
                raise HTTPException(422, '输入内容长度必须为1至10000字符')
            if action == 'key' and key not in ('enter', 'escape', 'tab', 'down', 'up', 'search'):
                raise HTTPException(422, '不支持的按键')
            # Consume observations before mutations: uncertain sends must never auto-retry.
            self.states.clear()
            return await self.execute({'action': action, 'element_id': element_id, 'text': text, 'key': key})
