import pytest
from app.evaluation_judge import Judgment, make_report


def judgment():
    return Judgment.model_validate({'conclusion':'完成主要内容','objectives':[
        {'name':'内容','weight':80,'completion':90,'reason':'已提供','gap':'少量遗漏','evidence':[{'file_id':'actual/中文.md','quote':'真实内容'}]},
        {'name':'视觉','weight':20,'completion':None,'reason':'图片排除','gap':'待检查','evidence':[]}],
        'matches':[{'reference_ids':['reference/old.md'],'actual_ids':['actual/中文.md'],'reason':'同类文档'}],
        'improvements':[],'regressions':[]})


def test_estimate_weights_unknowns_and_renamed_files():
    report=make_report(judgment(),[{'id':'actual/中文.md','content':'真实内容'},{'id':'reference/old.md','content':'参考'}],[],'model')
    assert report['completion_percent']==72
    assert report['coverage_percent']==80
    assert report['status']=='estimated'


@pytest.mark.parametrize('kind',['quote','file','score','weight'])
def test_invalid_evidence_and_scores_fail_closed(kind):
    value=judgment()
    if kind=='quote': value.objectives[0].evidence[0].quote='虚构'
    if kind=='file': value.objectives[0].evidence[0].file_id='actual/missing.md'
    if kind=='score': value.objectives[0].completion=101
    if kind=='weight': value.objectives[0].weight=50
    with pytest.raises(ValueError):
        make_report(value,[{'id':'actual/中文.md','content':'真实内容'},{'id':'reference/old.md','content':'参考'}],[],'model')
