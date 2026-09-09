"""Resolve human support for an employee-centric project without rewriting legacy drafts."""
DEFAULT_HUMAN = '@project_owner'


def human_support(draft):
    members = draft.get('members', [])
    humans = [m for m in members if m['kind'] == 'human']
    routing = draft.get('human_routing') or {}
    default = routing.get('default_owner') or (humans[0]['key'] if humans else DEFAULT_HUMAN)
    assignments = routing.get('assignments') or {}
    if not humans or default == DEFAULT_HUMAN or DEFAULT_HUMAN in assignments.values():
        humans = [{'key': DEFAULT_HUMAN, 'name': '项目负责人（你）', 'kind': 'human',
                   'role': '处理需要人工判断、补充信息或确认的问题', 'responsibilities': [],
                   'instructions': '', 'skills': [], 'inputs': [], 'outputs': []}, *humans]
    return {'default_owner': default, 'humans': humans,
            'assignments': {m['key']: assignments.get(m['key'], default) for m in members if m['kind'] == 'ai'}}
