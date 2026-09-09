from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Member(Strict):
    key: str = Field(pattern=r"^[a-z][a-z0-9_-]{0,63}$")
    name: str = Field(min_length=1, max_length=100)
    role: str = Field(min_length=1, max_length=200)
    kind: Literal["ai", "human"]
    responsibilities: list[str] = Field(max_length=20)
    instructions: str = Field(max_length=20000)
    skills: list[str] = Field(max_length=20)
    inputs: list[str] = Field(max_length=20)
    outputs: list[str] = Field(max_length=20)


class Step(Strict):
    key: str = Field(pattern=r"^[a-z][a-z0-9_-]{0,63}$")
    name: str = Field(min_length=1, max_length=200)
    owner: str
    kind: Literal["work", "review", "approval"]
    depends_on: list[str]
    input: str
    output: str
    acceptance: str


class Requirement(Strict):
    name: str
    description: str
    blocking: bool


class Draft(Strict):
    name: str = Field(min_length=1, max_length=200)
    goal: str = Field(max_length=10000)
    members: list[Member] = Field(max_length=20)
    workflow: list[Step] = Field(max_length=50)
    requirements: list[Requirement] = Field(max_length=30)
    assumptions: list[str] = Field(max_length=20)
    questions: list[str] = Field(max_length=50)
    ready: bool

    @model_validator(mode="after")
    def validate_graph(self):
        members = [x.key for x in self.members]
        keys = [x.key for x in self.workflow]
        if len(set(members)) != len(members) or len(set(keys)) != len(keys):
            raise ValueError("岗位和流程标识不能重复")
        graph = {s.key: s.depends_on for s in self.workflow}
        for step in self.workflow:
            if step.owner not in members:
                raise ValueError(f"步骤 {step.key} 的负责人不存在")
            if step.kind == "approval" and next(m for m in self.members if m.key == step.owner).kind != "human":
                raise ValueError("人工决策步骤必须交给人类岗位")
            if any(dep not in graph for dep in step.depends_on):
                raise ValueError(f"步骤 {step.key} 引用了不存在的前置工作")
        visited, visiting = set(), set()

        def visit(key):
            if key in visiting:
                raise ValueError("工作流不能包含循环依赖，请用独立返工轮次表示")
            if key in visited:
                return
            visiting.add(key)
            for dep in graph[key]:
                visit(dep)
            visiting.remove(key)
            visited.add(key)

        for key in graph:
            visit(key)
        if self.ready and (not self.members or not self.workflow or not self.goal.strip()):
            raise ValueError("可创建草稿需要目标、团队和工作流")
        if self.ready:
            for member in self.members:
                if member.kind == "ai" and (
                    not member.instructions.strip()
                    or not any(value.strip() for value in member.inputs)
                    or not any(value.strip() for value in member.outputs)
                ):
                    raise ValueError(f"员工 {member.name} 缺少工作指令、输入或交付成果，不能标记为就绪")
            for step in self.workflow:
                if not all(value.strip() for value in (step.input, step.output, step.acceptance)):
                    raise ValueError(f"步骤 {step.name} 缺少输入、输出或验收条件，不能标记为就绪")
        return self


class DesignResponse(Strict):
    reply: str = Field(min_length=1, max_length=15000)
    draft: Draft


class SendMessage(Strict):
    content: str = Field(default="", max_length=12000)
    attachment_ids: list[str] = Field(default_factory=list, max_length=4)
    request_id: str = Field(min_length=1, max_length=100)
    expected_version: int


class EditEmployee(Strict):
    expected_version: int
    profile: Member
    files: dict[str, str]


class EditDraft(Strict):
    expected_version: int
    draft: Draft
