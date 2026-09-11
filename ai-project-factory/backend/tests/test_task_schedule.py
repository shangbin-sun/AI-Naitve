import asyncio
from datetime import datetime, timezone, timedelta
import pytest
from fastapi import HTTPException
from app.task_schedule import TaskSchedule, TaskScheduler
from app.agent_models import AgentRun
from app.models import now
from test_agent_runs import manager


def endpoint(manager, tail="", method="POST"):
    path = "/api/workspaces/{project}/task-schedules" + tail
    return next(
        r.endpoint
        for r in manager.app.routes
        if getattr(r, "path", None) == path and method in r.methods
    )


def create(manager, kind="loop", max_runs=3):
    fn = endpoint(manager)
    payload = fn.__annotations__["body"](
        task={
            "title": "定时测试",
            "description": "分析输入",
            "scope": "node",
            "node": "analyze",
            "request_id": "schedule-request",
        },
        schedule={
            "kind": kind,
            "stop_condition": "所有检查通过",
            "max_runs": max_runs,
            "start_at": datetime.now(timezone.utc) + timedelta(hours=1),
        },
    )
    run = fn(manager.project_id, payload)
    scheduler = manager.app.state.task_scheduler
    with manager.sessions() as db:
        sid = db.query(TaskSchedule).one().id
    return scheduler, sid, run


def set_due(manager, sid):
    with manager.sessions.begin() as db:
        db.get(TaskSchedule, sid).next_at = now()


def set_finished(manager, rid, status="completed"):
    with manager.sessions.begin() as db:
        db.get(AgentRun, rid).status = status


def test_schedule_survives_restart_and_runs_once_without_duplicates(manager):
    scheduler, sid, run = create(manager, "once")
    launched = []
    manager.launch = lambda *args: launched.append(args)
    asyncio.run(scheduler.tick())
    assert not launched
    set_due(manager, sid)
    asyncio.run(TaskScheduler(manager).tick())
    asyncio.run(scheduler.tick())
    assert len(launched) == 1
    set_finished(manager, run["id"])
    asyncio.run(scheduler.tick())
    with manager.sessions() as db:
        assert db.get(TaskSchedule, sid).status == "completed"


def test_loop_same_task_new_batches_and_evidence_stops(manager):
    scheduler, sid, run = create(manager)
    manager.launch = lambda *args: None

    async def judge(spec, run):
        return {"decision": "not_met", "reason": "还有一项检查失败"}

    scheduler.judge = judge
    set_due(manager, sid)
    asyncio.run(scheduler.tick())
    set_finished(manager, run["id"])
    asyncio.run(scheduler.tick())
    set_due(manager, sid)
    asyncio.run(scheduler.tick())
    with manager.sessions() as db:
        row = db.get(TaskSchedule, sid)
        second = db.get(AgentRun, row.current_run)
        assert (
            second.id != run["id"]
            and second.task_id == run["task_id"]
            and row.iterations == 2
        )
        assert (
            second.thread_id is None
            and second.state["nodes"]["analyze"]["status"] == "pending"
        )
        second_id = second.id

    async def met(spec, run):
        return {"decision": "met", "reason": "所有检查已通过"}

    scheduler.judge = met
    set_finished(manager, second_id)
    asyncio.run(scheduler.tick())
    with manager.sessions() as db:
        assert db.get(TaskSchedule, sid).status == "completed"


@pytest.mark.parametrize(
    "outcome", ["failed", "waiting_human", "interrupted", "cancelled", "unknown"]
)
def test_problem_or_unknown_pauses_automation(manager, outcome):
    scheduler, sid, run = create(manager)
    manager.launch = lambda *args: None
    set_due(manager, sid)
    asyncio.run(scheduler.tick())

    async def unknown(spec, run):
        return {"decision": "unknown", "reason": "缺少实际检查结果"}

    scheduler.judge = unknown
    set_finished(manager, run["id"], "completed" if outcome == "unknown" else outcome)
    asyncio.run(scheduler.tick())
    with manager.sessions() as db:
        assert db.get(TaskSchedule, sid).status == "paused"


def test_limit_pause_and_cross_team_access(manager):
    scheduler, sid, run = create(manager, "interval", 1)
    manager.launch = lambda *args: None
    with pytest.raises(HTTPException) as error:
        endpoint(manager, "/{schedule_id}/{action}")("foreign", sid, "pause")
    assert error.value.status_code == 404
    endpoint(manager, "/{schedule_id}/{action}")(manager.project_id, sid, "pause")
    set_due(manager, sid)
    asyncio.run(scheduler.tick())
    with manager.sessions() as db:
        assert db.get(TaskSchedule, sid).iterations == 0
    endpoint(manager, "/{schedule_id}/{action}")(manager.project_id, sid, "resume")
    asyncio.run(scheduler.tick())
    set_finished(manager, run["id"])
    asyncio.run(scheduler.tick())
    with manager.sessions() as db:
        assert db.get(TaskSchedule, sid).status == "paused"


def test_other_batch_prevents_overlap(manager):
    scheduler, sid, run = create(manager, "once")
    launched = []
    manager.launch = lambda *args: launched.append(args)
    from app.agent_runs import NewAgentTask

    manager.create(
        manager.project_id,
        NewAgentTask(
            title="定时测试",
            description="分析输入",
            scope="node",
            node="analyze",
            task_id=run["task_id"],
            source_run=run["id"],
            request_id="manual",
        ),
    )
    set_due(manager, sid)
    asyncio.run(scheduler.tick())
    assert not launched


def test_schedule_creation_is_idempotent(manager):
    _, sid, run = create(manager)
    fn = endpoint(manager)
    with manager.sessions() as db:
        spec = db.get(TaskSchedule, sid).spec
    body = fn.__annotations__["body"](
        task={
            "title": "定时测试",
            "description": "分析输入",
            "scope": "node",
            "node": "analyze",
            "request_id": "schedule-request",
        },
        schedule=spec,
    )
    assert fn(manager.project_id, body)["id"] == run["id"]
    body.schedule.max_runs = 99
    with pytest.raises(HTTPException) as error:
        fn(manager.project_id, body)
    assert error.value.status_code == 409
    with manager.sessions() as db:
        assert db.query(AgentRun).count() == 1


def test_http_schedule_contract_and_validation(manager):
    from fastapi.testclient import TestClient

    client = TestClient(manager.app)
    url = f"/api/workspaces/{manager.project_id}/task-schedules"
    task = {
        "title": "API测试",
        "description": "检查调度接口",
        "scope": "node",
        "node": "analyze",
        "request_id": "http-schedule",
    }
    assert (
        client.post(
            url, json={"task": task, "schedule": {"kind": "loop", "stop_condition": ""}}
        ).status_code
        == 422
    )
    response = client.post(
        url,
        json={
            "task": task,
            "schedule": {
                "kind": "once",
                "start_at": (
                    datetime.now(timezone.utc) + timedelta(hours=1)
                ).isoformat(),
            },
        },
    )
    assert response.status_code == 202, response.text
    assert response.json()["status"] == "scheduled"
    schedules = client.get(url).json()
    assert len(schedules) == 1 and schedules[0]["iterations"] == 0
    assert client.post(f"{url}/{schedules[0]['id']}/pause").json()["status"] == "paused"
