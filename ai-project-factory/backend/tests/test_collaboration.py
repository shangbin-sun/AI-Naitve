import copy
import pytest
from pydantic import ValidationError
from app.schemas import Draft
from app.collaboration import human_support
from test_factory import DRAFT


def test_legacy_draft_remains_unchanged_and_has_default_human():
    draft = Draft.model_validate(DRAFT).model_dump()
    assert draft == DRAFT
    assert human_support(draft)['assignments'] == {'analyst': 'owner'}
    draft['members'] = [m for m in draft['members'] if m['kind']=='ai']
    draft['workflow'] = draft['workflow'][:1]
    support = human_support(draft)
    assert support['default_owner']=='@project_owner'
    assert support['humans'][0]['name']=='项目负责人（你）'
    assert len(draft['members'])==1


def test_specialist_human_routing_and_round_trip():
    draft = copy.deepcopy(DRAFT)
    draft['members'].extend([{**draft['members'][0], 'key':'architect','name':'架构AI'}, {**draft['members'][1], 'key':'architect_owner','name':'架构负责人'}])
    draft['human_routing']={'default_owner':'owner','assignments':{'architect':'architect_owner'}}
    saved = Draft.model_validate(draft).model_dump()
    assert saved['human_routing']==draft['human_routing']
    assert human_support(saved)['assignments']=={'analyst':'owner','architect':'architect_owner'}


@pytest.mark.parametrize('routing', [
    {'default_owner':'analyst','assignments':{}},
    {'default_owner':'foreign','assignments':{}},
    {'assignments':{'owner':'owner'}},
    {'assignments':{'analyst':'foreign'}},
])
def test_routing_requires_existing_ai_and_human_members(routing):
    with pytest.raises(ValidationError): Draft.model_validate({**DRAFT,'human_routing':routing})
