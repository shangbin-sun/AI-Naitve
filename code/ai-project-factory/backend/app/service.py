import copy
import json
from pathlib import PurePosixPath

from fastapi import HTTPException
from sqlalchemy import select, update

from .models import Design, Employee, Project, Revision, now
from .schemas import Draft, EditEmployee


def get_design(db, identity):
    row = db.get(Design, identity)
    if not row:
        raise HTTPException(404, "项目不存在")
    return row


def scaffold(profile):
    return {
        "instructions/role.md": profile["instructions"],
        "README.md": f"# {profile['name']}\n\n{profile['role']}\n\n这是自动生成的员工工程草稿，请完善工具、环境并评测后使用。\n",
        "evaluations/example.json": json.dumps({"input": profile["inputs"], "expected_outputs": profile["outputs"]}, ensure_ascii=False, indent=2),
    }


def validate_files(files):
    if len(files) > 100 or sum(len(v.encode()) for v in files.values()) > 2_000_000:
        raise HTTPException(422, "工程最多 100 个文件，总大小不超过 2 MB")
    for name in files:
        p = PurePosixPath(name)
        skill_path = len(p.parts) >= 4 and p.parts[:2] == (".agents", "skills") and not any(x.startswith(".") for x in p.parts[2:])
        if not name or p.is_absolute() or ".." in p.parts or "\\" in name or str(p) != name or (any(x.startswith(".") for x in p.parts) and not skill_path):
            raise HTTPException(422, "文件路径必须是工程内的普通相对路径")
        if name == "employee.json":
            raise HTTPException(422, "employee.json 由岗位配置生成，请在职责页修改")


def apply_draft(db, identity, expected, draft, source):
    draft = Draft.model_validate(draft).model_dump()
    row = get_design(db, identity)
    changed = db.execute(update(Design).where(Design.id == identity, Design.version == expected).values(
        draft=draft, title=draft["name"], version=expected + 1, updated_at=now(),
    ))
    if changed.rowcount != 1:
        raise HTTPException(409, "草稿已发生变化，本次修改未覆盖新内容，请刷新后重试")
    db.add(Revision(design_id=identity, version=expected + 1, source=source, draft=draft))
    # Every proposed AI member has an editable project engineering draft.
    existing = {e.key: e for e in db.scalars(select(Employee).where(Employee.design_id == identity))}
    active_keys = set()
    for member in draft["members"]:
        if member["kind"] != "ai":
            continue
        active_keys.add(member["key"])
        old = existing.get(member["key"])
        if old:
            if old.profile != member:
                files = copy.deepcopy(old.files)
                files["instructions/role.md"] = member["instructions"]
                old.profile, old.files = member, files
                old.version += 1
                old.updated_at = now()
            old.active = True
        else:
            db.add(Employee(design_id=identity, key=member["key"], profile=member, files=scaffold(member)))
    for key, employee in existing.items():
        if key not in active_keys:
            employee.active = False
    db.flush()
    db.refresh(row)
    return row


def edit_employee(db, identity, data: EditEmployee):
    employee = db.get(Employee, identity)
    if not employee or not employee.active:
        raise HTTPException(404, "员工不存在或已退出当前团队")
    if employee.version != data.expected_version:
        raise HTTPException(409, "员工已被修改，请刷新后重试")
    if data.profile.key != employee.key or data.profile.kind != "ai":
        raise HTTPException(422, "员工标识和类型不能在详情页修改，请调整团队方案")
    validate_files(data.files)
    design = get_design(db, employee.design_id)
    draft = copy.deepcopy(design.draft)
    profile = data.profile.model_dump()
    for i, member in enumerate(draft["members"]):
        if member["key"] == employee.key:
            draft["members"][i] = profile
    version = employee.version
    apply_draft(db, design.id, design.version, draft, "manual_employee")
    # Role instructions are canonical in the profile; file and form share this value.
    employee.profile = profile
    employee.files = {**data.files, "instructions/role.md": profile["instructions"]}
    employee.version = version + 1
    employee.updated_at = now()
    db.flush()
    return employee


def instantiate(db, identity, expected):
    design = get_design(db, identity)
    if design.version != expected:
        raise HTTPException(409, "团队已更新，请刷新后创建项目")
    if not design.draft.get("ready"):
        raise HTTPException(422, "请先通过聊天明确目标、岗位和工作流程")
    existing = db.scalar(select(Project).where(Project.design_id == identity, Project.design_version == expected))
    if existing:
        return existing
    employees = list(db.scalars(select(Employee).where(Employee.design_id == identity, Employee.active.is_(True))))
    snapshot = {"team": copy.deepcopy(design.draft), "employees": [
        {"id": e.id, "version": e.version, "profile": copy.deepcopy(e.profile), "files": copy.deepcopy(e.files)} for e in employees
    ]}
    project = Project(design_id=identity, design_version=expected, title=design.title, snapshot=snapshot)
    db.add(project)
    db.flush()
    return project
