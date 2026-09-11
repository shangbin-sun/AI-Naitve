import copy
import hashlib
import pytest
from app.employee_context import employee_context
from test_agent_runs import manager, create, control, active


def test_bundle_includes_full_rules_skills_and_hashes(manager):
    run=create(manager,'node');active(manager,run)
    bundle=control(manager,run,'begin',node='analyze')['instruction_bundle']
    assert {'organization','rules','role','skill'} <= {e['kind'] for e in bundle['entries']}
    for entry in bundle['entries']:
        assert entry['content'] in bundle['content']
        assert entry['sha256']==hashlib.sha256(entry['content'].encode()).hexdigest()
    assert bundle['employee_key']=='analyst' and bundle['resources']


def test_missing_or_invalid_rules_fail_closed(manager):
    snapshot=manager.workspaces.snapshot(manager.project_id)
    broken=copy.deepcopy(snapshot)
    broken['definition']['employees']['analyst']['files'].pop('AGENTS.md')
    with pytest.raises(ValueError,match='必需规则缺失'): employee_context(broken,'analyst')
    broken=copy.deepcopy(snapshot)
    broken['definition']['employees']['analyst']['files']['.agents/skills/bad/SKILL.md']='missing metadata'
    with pytest.raises(ValueError,match='Skill 元数据无效'): employee_context(broken,'analyst')
