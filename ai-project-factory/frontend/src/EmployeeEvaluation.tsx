import { useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Card, Checkbox, Empty, Space, Tag } from 'antd';
import { api } from './api';
import WorkflowEditor, {type EmployeeWorkflow} from './tasks/EmployeeWorkflowEditor';

type Check = {name:string; kind:'contains'|'exact'|'json'|'number'|'manual'; expected:string; tolerance:number};
type EvidenceFile = {name:string;path:string;size:number;text:boolean};
type FileSet = {file_mode?:boolean;input_files?:EvidenceFile[];output_files?:EvidenceFile[];auto_trial?:boolean;decision?:string;score_changes?:{case_id:string;before:number;after:number|null;delta:number|null}[]};
type SemanticReport = {completion_percent?:number|null;coverage_percent?:number;conclusion?:string; objectives?:{name:string;weight:number;completion:number|null;reason:string;gap:string;evidence:{file_id:string;quote:string}[]}[];matches?:{reference_ids:string[];actual_ids:string[];reason:string}[];improvements?:string[];regressions?:string[];excluded_files?:{file_id:string;reason:string}[]};
type Result = FileSet & {case_id:string; title:string; actual:string; report:SemanticReport & {status:string; diff:string; note:string; reference_equal:boolean|null; checks:(Check & {status:string;detail:string})[]}};
type RecordRow = FileSet & {id:string; kind:string; status:string; created_at:string; title?:string; employee_version?:number; input_text?:string; reference?:string; reference_status?:string; error?:string; cases?:(FileSet & {id:string;title:string;reference:string})[]; results?:Result[]; baseline_id?:string; candidate_id?:string; workflow?:EmployeeWorkflow; base_workflow?:EmployeeWorkflow; comparison?:{case_id:string;before:string;after:string;change:string}[]};
const statusName:Record<string,string> = {ready:'待确认',queued:'排队中',running:'运行中',completed:'已完成',failed:'失败',interrupted:'已中断',adopted:'已采用',passed:'规则通过',unverified:'未验证',improved:'改善',regressed:'退化',unchanged:'未变'};

export default function EmployeeEvaluation({employeeId, version, disabled, onAdopted, initialCaseId, activeRunId}: {employeeId:string;version:number;disabled:boolean;onAdopted:()=>Promise<void>;initialCaseId?:string;activeRunId?:string}) {
  const {modal} = App.useApp();
  const base = `/employees/${employeeId}/evaluation`;
  const [records,setRecords] = useState<RecordRow[]>([]);
  const [selected,setSelected] = useState<string[]>([]), [busy,setBusy] = useState(false), [error,setError] = useState('');
  const selectedInitialCases = useRef(false);
  const adopted = useRef(new Set<string>());
  useEffect(()=>{
    const fresh=records.filter(r=>r.auto_trial&&r.status==='adopted'&&!adopted.current.has(r.id));
    if(fresh.length){fresh.forEach(r=>adopted.current.add(r.id));void onAdopted();}
  },[records,onAdopted]);
  async function refresh() {
    const rows = await api<RecordRow[]>(base);
    setRecords(rows);
    if (!selectedInitialCases.current) {
      selectedInitialCases.current = true;
      setSelected(rows.filter(row=>row.kind==='case'&&(!initialCaseId||row.id===initialCaseId)).map(row=>row.id));
    }
  }
  useEffect(() => {
    let live = true;
    selectedInitialCases.current = false;
    const load = () => refresh().catch(e=>{if(live)setError(e.message);});
    void load();
    const timer = setInterval(load,3000);
    return ()=>{live=false;clearInterval(timer);};
  },[base,initialCaseId]);
  async function action(path:string, body:unknown = {}) {
    setBusy(true);setError('');
    try {await api(base+path,{method:'POST',body:JSON.stringify(body)});await refresh();return true;}
    catch(e){setError((e as Error).message);return false;} finally{setBusy(false);}
  }
  const locked=busy||disabled;
  const runs = records.filter(row=>row.kind!=='case');
  const orderedRuns = activeRunId ? [...runs.filter(row=>row.id===activeRunId), ...runs.filter(row=>row.id!==activeRunId)] : runs;
  const baselineRunning = records.some(row=>row.kind==='run'&&['queued','running'].includes(row.status)&&!row.candidate_id&&!row.baseline_id&&row.employee_version===version&&row.cases?.length===selected.length&&row.cases.every(item=>selected.includes(item.id)));
  function files(items:EvidenceFile[]|undefined, href?:(f:EvidenceFile)=>string, inputs=false) {
    return <ul>{items?.map(f=><li key={f.name}>{href?<a href={href(f)}>{f.name}</a>:f.name} · {f.size} B · {inputs?'输入原文件':f.text?'参与文本对比':'非文本，未参与评测'}</li>)}</ul>;
  }
  const fileUrl=(id:string,group:string,name:string,caseId?:string)=>`/api${base}/${id}/file?group=${group}&name=${encodeURIComponent(name)}${caseId?`&case_id=${encodeURIComponent(caseId)}`:''}`;
  return <section aria-label="员工评测与调优">
    <Alert type="info" showIcon message="任务案例 → 基线评测 → 差异报告 → 调优候选 → 对照评测 → 手动采用"
      description="输入与输出按原文件保存独立快照。员工在受限临时目录中执行；仅文本输出参与对比，图片等非文本保留但不评分。历史参考文件不放入员工执行目录。"/>
    {disabled&&<Alert type="warning" message="请先保存员工页面的修改，再进行评测。"/>}
    {error&&<Alert type="error" message={error} closable onClose={()=>setError('')}/>}
    <h3>评测案例</h3>
    <Alert type="info" showIcon message="成功完成且有实际输出的任务会自动导入一次"
      description="失败、中断或没有输出文件的运行不会导入。按“任务 + 员工”去重；进入此页后已导入案例可直接开始基线评测。"/>
    {!records.some(r=>r.kind==='case')&&<Empty description="暂无可评测案例。完成一次有实际输出的员工任务后会自动出现。"/>}
    {records.filter(r=>r.kind==='case').map(row=><Card key={row.id} size="small" style={{marginBottom:8}}><Checkbox checked={selected.includes(row.id)} onChange={e=>setSelected(e.target.checked?[...selected,row.id]:selected.filter(id=>id!==row.id))}>{row.title}</Checkbox><Tag>{row.reference_status==='confirmed'?'参考已确认':row.reference_status==='none'?'无参考':'历史对照'}</Tag>
      <details><summary>输入与参考输出</summary>{row.file_mode?<><h4>输入文件</h4><a href={fileUrl(row.id,'inputs','task.json')}>task.json</a>{files(row.input_files,f=>fileUrl(row.id,'inputs',f.name),true)}<h4>参考输出文件</h4>{files(row.output_files,f=>fileUrl(row.id,'reference',f.name))}</>:<><pre style={{whiteSpace:'pre-wrap'}}>{row.input_text}</pre><pre style={{whiteSpace:'pre-wrap'}}>{row.reference}</pre></>}</details>
    </Card>)}
    <Button type="primary" aria-label="使用已保存版本开始基线评测" loading={baselineRunning} disabled={locked||!selected.length||baselineRunning} onClick={()=>void action('/runs',{case_ids:selected,expected_version:version})}>使用已保存版本开始基线评测</Button>
    <h3>评测记录与调优</h3>
    {orderedRuns.map(row=><Card key={row.id} style={{marginBottom:14}} title={`${row.kind==='candidate'?'调优候选':row.candidate_id?'候选对照评测':'基线评测'} · ${row.created_at}`} extra={<Tag>{row.status==='completed'?'执行已结束':statusName[row.status]||row.status}</Tag>}>
      <p>{row.id===activeRunId&&<Tag>本次聊天评测</Tag>}员工版本 v{row.employee_version}</p>
      {row.decision&&<Alert type={row.status==='adopted'?'success':'info'} message={row.decision}/>}
      {row.score_changes?.map(s=><p key={s.case_id}>估算完成度：{s.before}% → {s.after==null?'未完成评测':`${s.after}%`}（{s.delta==null?'无法比较':`${s.delta>0?'+':''}${s.delta} 个百分点`}）</p>)}
      {row.error&&<Alert type="error" message={row.error}/>}
      {['running','queued'].includes(row.status)&&<Button disabled={busy} onClick={()=>void action(`/${row.id}/cancel`)}>停止本次运行</Button>}
      {row.results?.map(result=><details key={result.case_id} open={result.report.status==='estimated'}><summary>{result.title} · {result.report.status==='estimated'?'模型评测完成':statusName[result.report.status]}</summary>
        {result.report.status==='estimated'&&<section>
          <h3>目标完成度：{result.report.completion_percent == null?'无法估算':`约 ${result.report.completion_percent}%`}</h3>
          <p>可判断目标权重：{result.report.coverage_percent}% · 模型估算，不是测试通过率</p>
          <p>{result.report.conclusion}</p>
          {result.report.objectives?.map((g,i)=><details key={i}><summary>{g.name} · {g.completion==null?'无法判断':`${g.completion}%`} · 权重 {g.weight}%</summary><p>{g.reason}</p><p>待补齐：{g.gap||'无'}</p>{g.evidence.map((e,j)=><blockquote key={j}>{e.file_id}：{e.quote}</blockquote>)}</details>)}
          <h4>改善与退化</h4><ul>{result.report.improvements?.map((s,i)=><li key={'i'+i}>改善：{s}</li>)}{result.report.regressions?.map((s,i)=><li key={'r'+i}>退化：{s}</li>)}</ul>
          <details><summary>文件对应关系与评测范围</summary><ul>{result.report.matches?.map((m,i)=><li key={i}>{m.reference_ids.join('、')} → {m.actual_ids.join('、')}：{m.reason}</li>)}{result.report.excluded_files?.map((f,i)=><li key={'e'+i}>{f.file_id}：{f.reason}</li>)}</ul></details>
        </section>}
        <div className="workflow-compare-row"><section><h4>参考输出</h4>{row.cases?.find(c=>c.id===result.case_id)?.file_mode?files(row.cases.find(c=>c.id===result.case_id)?.output_files,f=>fileUrl(result.case_id,'reference',f.name)):<pre style={{whiteSpace:'pre-wrap'}}>{row.cases?.find(c=>c.id===result.case_id)?.reference||'未设置'}</pre>}</section><section><h4>本次输出</h4>{files(result.output_files,f=>fileUrl(row.id,'outputs',f.name,result.case_id))}<pre style={{whiteSpace:'pre-wrap'}}>{result.actual}</pre></section></div>
        {result.report.status!=='estimated'&&<><h4>差异</h4><pre style={{whiteSpace:'pre-wrap'}}>{result.report.diff||(result.report.reference_equal===true?'文本一致':'尚未生成有效内容对比，请查看评测说明或重新运行基线评测')}</pre></>}
        <ul>{result.report.checks.map((c,i)=><li key={i}>{c.name}：{c.status==='excluded'?'未参与评测':statusName[c.status]} · {c.detail}</li>)}</ul><p>{result.report.note}</p>
      </details>)}
      {!!row.comparison?.length&&<ul>{row.comparison.map(c=><li key={c.case_id}>{row.cases?.find(k=>k.id===c.case_id)?.title}：{statusName[c.before]} → {statusName[c.after]} · {statusName[c.change]}</li>)}</ul>}
      {row.kind==='run'&&row.status==='completed'&&<Button disabled={locked||!row.results?.every(r=>r.report.status==='estimated')} onClick={()=>void action(`/runs/${row.id}/optimize?auto_trial=true`)}>生成新 Workflow 并试跑，提升后采用</Button>}
      {row.kind==='candidate'&&row.workflow&&<>
        <details><summary>查看候选 WorkFlow</summary><WorkflowEditor value={row.workflow} saved onChange={()=>{}} onSave={()=>{}}/></details>
        <details><summary>查看原 WorkFlow</summary><pre style={{whiteSpace:'pre-wrap'}}>{JSON.stringify(row.base_workflow,null,2)}</pre></details>
        {row.status==='ready'&&!row.auto_trial&&<Space wrap>
          <Button disabled={locked} onClick={()=>{
            const baseline=records.find(r=>r.id===row.baseline_id);
            if(baseline?.cases) void action('/runs',{case_ids:baseline.cases.map(c=>c.id),expected_version:version,baseline_id:baseline.id,candidate_id:row.id});
          }}>使用原案例做对照评测</Button>
          <Button disabled={locked||!records.some(r=>r.kind==='run'&&r.candidate_id===row.id&&r.status==='completed')} onClick={()=>modal.confirm({title:'采用此候选为员工新版本？',content:'请先检查差异、未验证项与退化项。采用不会修改历史任务，但该员工的新任务将使用新版本。',okText:'确认采用',onOk:async()=>{
            const evaluation=records.find(r=>r.kind==='run'&&r.candidate_id===row.id&&r.status==='completed');
            if(await action(`/candidates/${row.id}/adopt`,{expected_version:version,evaluation_id:evaluation!.id})) await onAdopted();
          }})}>采用候选</Button>
        </Space>}
      </>}
    </Card>)}
  </section>;
}
