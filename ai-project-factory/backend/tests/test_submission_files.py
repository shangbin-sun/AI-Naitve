import pytest
from app.independent_runs import submission_files, Submission
from test_agent_runs import manager
from test_independent_runs import setup, execute, state


@pytest.fixture
def root(tmp_path):
    (tmp_path/'outputs').mkdir()
    (tmp_path/'logs').mkdir()
    (tmp_path/'outputs/report.md').write_text('正式输出')
    return tmp_path


@pytest.mark.parametrize('log', ['logs/verification.txt','../logs/verification.md'])
def test_optional_missing_log_does_not_block(root,log):
    files, notes=submission_files(root,['report.md',log],'需求文档')
    assert [name for name,_ in files]==['report.md']
    assert log in notes[0]


def test_required_log_still_checked(root):
    with pytest.raises(ValueError,match='输出文件缺失'):
        submission_files(root,['report.md','logs/verification.txt'],'logs/verification.txt')
    (root/'logs/verification.txt').write_text('证据')
    assert len(submission_files(root,['report.md','logs/verification.txt'],'logs/verification.txt')[0])==2


@pytest.mark.parametrize('name',['../secret','/etc/passwd','logs/../../secret','../logs/../../secret','outputs/../secret'])
def test_unsafe_paths_remain_blocked(root,name):
    with pytest.raises(ValueError): submission_files(root,['report.md',name],'')


def test_only_logs_and_missing_real_output_rejected(root):
    with pytest.raises(ValueError,match='正式输出'): submission_files(root,['logs/a.txt'],'')
    with pytest.raises(ValueError,match='输出文件缺失'): submission_files(root,['missing.md','logs/a.txt'],'')
    (root/'outputs/link.md').symlink_to(root/'outputs/report.md')
    with pytest.raises(ValueError,match='符号链接'): submission_files(root,['link.md'],'')


def test_blank_verification_is_not_a_delivery_gate(manager):
    run,_=setup(manager);execute(manager,run)
    manager.independent.submit(manager.project_id,run['id'],'analyze',Submission(
        summary='交付',verification='',artifacts=['result.txt','logs/verification.txt']))
    node=state(manager,run)['nodes']['analyze']
    assert node['status']=='completed'
    assert len(node['artifacts'])==1
    assert node['submission_notes']
    assert node['acceptance_record']['actor']=='system'
