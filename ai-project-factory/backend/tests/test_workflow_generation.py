import asyncio
import copy
import json
import pytest

from app.agent_models import AgentRun
from app.employee_ability import WorkflowUpdate
from test_employee_tuning import manager, blocked, endpoint, Connection
from test_employee_ability import WORKFLOW


def test_isolated_schema_generation_and_save_compile_user_edits(manager):
    run = blocked(manager)
    with manager.sessions.begin() as db:
        row = db.get(AgentRun, run['id'])
        data = copy.deepcopy(row.state)
        data['nodes']['analyze']['tuning'] = {'messages': [{'role': 'user', 'content': '检查输入'}],
                                             'thread_id': 'existing-chat', 'status': 'completed'}
        row.state = data
    seen = []
    class Generator(Connection):
        async def run_turn(self, thread, inputs, event, turn, identity, schema=None, response_model=None):
            assert schema['additionalProperties'] is False
            seen.append(json.loads(inputs[0]['text']))
            await event({'type': 'reply', 'text': json.dumps({**WORKFLOW, 'summary': '补充输入检查',
                'approach': '先确认', 'inputs': [], 'outputs': [], 'open_questions': [], 'steps': [{**WORKFLOW['steps'][0], 'description': '', 'evidence': ['chat:0']}]})})
            return response_model.model_validate({**WORKFLOW, 'summary': '补充输入检查',
                'approach': '先确认', 'inputs': [], 'outputs': [], 'open_questions': [], 'steps': [{**WORKFLOW['steps'][0], 'description': '', 'evidence': ['chat:0']}]}), {}
    manager.connection_factory = Generator
    async def generate():
        await endpoint(manager, '/workflow-generation')(manager.project_id, run['id'], 'analyze')
        await manager.tasks['workflow:' + run['id'] + ':analyze']
    asyncio.run(generate())
    result = endpoint(manager, method='GET')(manager.project_id, run['id'], 'analyze')
    assert result['thread_id'] == 'existing-chat'
    assert result['messages'] == [{'role': 'user', 'content': '检查输入'}]
    assert result['workflow_generation']['status'] == 'completed'
    assert seen[0]['conversation'][-1]['content'] == '检查输入'
    assert seen[0]['previous_workflow'] is None
    proposal = result['ability_proposal']
    workflow = proposal['workflow']
    assert seen[0]['conversation'][0]['reference_id'] == 'chat:0'
    assert workflow['source']['messages'][0]['id'] == 'chat:0'
    workflow['steps'][0]['acceptance'] = '用户新验收条件'
    endpoint(manager, '/workflow')(manager.project_id, run['id'], 'analyze',
        WorkflowUpdate(workflow=workflow, proposal_id=proposal['id'], expected_version=proposal['expected_version']))
    ability = endpoint(manager, '/ability', 'GET')(manager.project_id, run['id'], 'analyze')
    assert '用户新验收条件' in ability['files']['.agents/skills/employee-workflow/SKILL.md']
    asyncio.run(generate())
    assert seen[-1]['previous_workflow']['steps'][0]['acceptance'] == '用户新验收条件'


def test_chat_method_prompt_and_optional_execution_fields():
    from app.workflow_generation import PROMPT, compile_workflow
    from app.employee_ability import validate_workflow
    assert '一个动作段对应一个 S 编号' in PROMPT
    assert '用户反复聊、反复修正' in PROMPT
    assert '保留反复强调的注意事项' in PROMPT
    assert '两个面向用户的字段' in PROMPT
    assert '主要任务”“注意事项”“输出校验' in PROMPT
    assert '不强制凑齐三栏' in PROMPT
    workflow = copy.deepcopy(WORKFLOW)
    workflow['steps'][0].update(input='', output='', acceptance='', requirements=['先确认含义'], actions=['结合样例核对'])
    validate_workflow(workflow)
    skill = compile_workflow(workflow)
    assert '注意事项：\n- 先确认含义' in skill
    assert '形成的做法：\n- 结合样例核对' in skill
    assert '验收：' not in skill


def test_unified_description_is_authoritative():
    from app.workflow_generation import compile_workflow
    from app.employee_ability import validate_workflow
    workflow = copy.deepcopy(WORKFLOW)
    workflow['steps'][0].update(description='先确认再处理，不能猜测', goal='', actions=['过时做法'])
    validate_workflow(workflow)
    skill = compile_workflow(workflow)
    assert '先确认再处理，不能猜测' in skill
    assert '过时做法' not in skill


def test_evidence_excerpts_are_bounded_and_keep_previous_method():
    from app.workflow_generation import source_excerpts
    sources = {'chat:0': {'role': 'user', 'content': '甲' * 3000},
               'chat:1': {'role': 'assistant', 'content': '未引用'}}
    result = source_excerpts(sources, {'chat:0', 'previous_workflow:S01'}, WORKFLOW)
    assert len(result) == 2
    assert result[0]['truncated'] is True
    assert len(result[0]['content']) == 2000
    assert result[1]['role'] == 'previous_workflow'
    assert result[1]['id'] == 'previous_workflow:S01'


def test_workflow_output_schema_requires_every_property_recursively():
    from app.workflow_generation import Workflow
    def check(node):
        if isinstance(node, dict):
            if node.get('type') == 'object':
                assert node.get('additionalProperties') is False
                assert set(node.get('required', [])) == set(node['properties'])
            for value in node.values():
                check(value)
        elif isinstance(node, list):
            for value in node:
                check(value)
    check(Workflow.model_json_schema())


def test_schema_rejection_is_distinguished_from_connection_failure():
    from app.codex_session import CodexTurnError
    error = CodexTurnError({'message': '{"error":{"code":"invalid_json_schema"}}'})
    assert error.invalid_schema
    assert 'Schema' in str(error)
    assert not CodexTurnError(None).invalid_schema


def test_contract_projection_preserves_rules_and_updates_managed_section():
    from app.workflow_generation import project_workflow
    from app.employee_ability import validate_workflow
    from fastapi import HTTPException
    workflow = {**copy.deepcopy(WORKFLOW), 'approach': '先确认依赖', 'inputs': [], 'outputs': [
        {'id': 'O01', 'name': '报告', 'description': '核对结论', 'format': 'Markdown', 'required': True, 'validation': '逐项检查来源'}]}
    validate_workflow(workflow)
    files = project_workflow({'AGENTS.md':'自定义规则\n', 'README.md':'保留'}, workflow)
    assert files['AGENTS.md'].startswith('自定义规则\n')
    assert '逐项检查来源' in files['AGENTS.md']
    assert '逐项检查来源' in files['.agents/skills/employee-workflow/SKILL.md']
    updated = project_workflow(files, {**workflow, 'approach':'新的整体方法'})
    assert updated['AGENTS.md'].count('ai-team:workflow-contract:start') == 1
    assert '先确认依赖' not in updated['AGENTS.md']
    assert updated['README.md'] == '保留'
    overridden = project_workflow({'AGENTS.md':'基础规则','AGENTS.override.md':'优先规则'}, workflow)
    assert overridden['AGENTS.md'] == '基础规则'
    assert '先确认依赖' in overridden['AGENTS.override.md']
    with pytest.raises(HTTPException):
        validate_workflow({**workflow, 'outputs':workflow['outputs'] * 2})


def test_native_evidence_maps_to_real_message_and_deduplicates():
    from app.workflow_generation import normalize_evidence, source_excerpts
    workflow = copy.deepcopy(WORKFLOW)
    workflow['steps'][0]['evidence'] = ['native-long-id', 'chat:0', 'previous_workflow:S01']
    conversation = [{'id': 'native-long-id', 'reference_id': 'chat:0', 'role': 'assistant', 'content': '真实消息'},
                    {'id': 'chat:0', 'reference_id': 'chat:1', 'role': 'user', 'content': '另一条消息'}]
    refs, cited = normalize_evidence(workflow, conversation, WORKFLOW)
    assert workflow['steps'][0]['evidence'] == ['chat:0', 'previous_workflow:S01']
    assert source_excerpts(refs, cited, WORKFLOW)[0]['content'] == '真实消息'


@pytest.mark.parametrize('reference', ['made-up', 'duplicate'])
def test_unverified_evidence_is_still_rejected(reference):
    from app.workflow_generation import normalize_evidence
    workflow = copy.deepcopy(WORKFLOW)
    workflow['steps'][0]['evidence'] = [reference]
    with pytest.raises(ValueError):
        normalize_evidence(workflow, [{'id':'duplicate','reference_id':'chat:0'},
                                      {'id':'duplicate','reference_id':'chat:1'}], None)
