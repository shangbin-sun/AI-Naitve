"""Optional real Chromium regression: install playwright and set DASHBOARD_CHROME."""
import os
import socket
import threading
import time

import pytest
import uvicorn

from app.dashboards import SaveDashboard, save_dashboard
from test_agent_runs import manager


@pytest.mark.skipif(not os.environ.get('DASHBOARD_CHROME'), reason='Explicit local Chromium path required')
def test_real_browser_isolates_generated_scripts(manager):
    from playwright.sync_api import sync_playwright
    from fastapi.responses import HTMLResponse

    @manager.app.get('/dashboard-test-host')
    def host():
        return HTMLResponse(f'<div id="private">private</div><iframe sandbox="allow-scripts" src="/api/workspaces/{manager.project_id}/dashboard/frame"></iframe>')

    script='''
document.body.dataset.value=window.DASHBOARD_DATA.value;
try { parent.parent.document.getElementById('private').textContent='changed'; document.body.dataset.parent='open'; }
catch { document.body.dataset.parent='blocked'; }
fetch('/api/workspaces').then(()=>document.body.dataset.network='open').catch(()=>document.body.dataset.network='blocked');
'''
    with manager.sessions.begin() as db:
        save_dashboard(db,manager.project_id,SaveDashboard(expected_version=0,title='Browser',files={'index.html':'<body><h1>看板</h1><script src="app.js"></script></body>','app.js':script},sample_data={'value':'42'}))
    sock=socket.socket(); sock.bind(('127.0.0.1',0)); port=sock.getsockname()[1]
    server=uvicorn.Server(uvicorn.Config(manager.app,log_level='error'))
    worker=threading.Thread(target=lambda:server.run(sockets=[sock]),daemon=True); worker.start()
    try:
        for _ in range(100):
            if server.started: break
            time.sleep(.02)
        with sync_playwright() as p:
            browser=p.chromium.launch(executable_path=os.environ['DASHBOARD_CHROME'],headless=True)
            page=browser.new_page()
            page.goto(f'http://127.0.0.1:{port}/dashboard-test-host')
            inner=page.frame_locator('iframe').frame_locator('iframe')
            inner.locator('body').wait_for()
            from playwright.sync_api import expect
            expect(inner.locator('body')).to_have_attribute('data-value','42')
            expect(inner.locator('body')).to_have_attribute('data-parent','blocked')
            expect(inner.locator('body')).to_have_attribute('data-network','blocked')
            assert page.locator('#private').inner_text()=='private'
            # Parent guard CSP also blocks a generated script navigating its own frame.
            requests=[]
            page.on('request',lambda r:requests.append(r.url))
            frame=next(f for f in page.frames if '/dashboard/page' in f.url)
            frame.evaluate("location.href='https://example.com/dashboard-exfil'")
            page.wait_for_timeout(200)
            assert not any('example.com' in url for url in requests), requests
            browser.close()
    finally:
        server.should_exit=True; worker.join(timeout=5); sock.close()
