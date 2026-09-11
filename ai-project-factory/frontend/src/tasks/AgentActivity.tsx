import { useEffect, useState } from "react";
import { Alert, Button, Empty, Select, Tag } from "antd";
import { api } from "../api";

type Activity = {status:string; activity:string; items:{id:string;title:string;status:string;text:string}[]};
const labels:Record<string,string> = {pending:"未开始",queued:"排队中",preparing:"准备中",running:"执行中",completed:"已完成",failed:"失败",waiting_human:"等待处理",interrupted:"已中断",cancelled:"已停止",inProgress:"执行中"};
export default function AgentActivity({projectId,runId,nodes,initialNode,tuning=false}:{projectId:string;runId:string;nodes:Record<string,{employee:{name:string}}>;initialNode?:string;tuning?:boolean}) {
  const [node,setNode] = useState(initialNode ?? "");
  const [data,setData] = useState<Activity>();
  const [error,setError] = useState("");
  const [revision,setRevision] = useState(0);
  useEffect(()=>{
    let live=true;let timer:ReturnType<typeof setTimeout>;
    setData(undefined);setError("");
    const poll=async()=>{
      try {
        const value=await api<Activity>(`/workspaces/${projectId}/agent-runs/${runId}/activity${node?`?node=${encodeURIComponent(node)}${tuning?"&tuning=true":""}`:""}`);
        if(live){setData(value);setError("");}
      } catch(e) {if(live)setError((e as Error).message);}
      finally {if(live)timer=setTimeout(poll,2500);}
    };
    void poll();return ()=>{live=false;clearTimeout(timer);};
  },[projectId,runId,node,revision,tuning]);
  return <div className="agent-activity">
    <div className="agent-activity-toolbar">
      <Select aria-label="查看Agent" value={node} onChange={setNode} options={[{value:"",label:"主 Agent · 任务调度"},...Object.entries(nodes).map(([key,n])=>({value:key,label:n.employee.name}))]}/>
      <Button onClick={()=>setRevision(v=>v+1)}>刷新</Button>
      {data && <Tag>{labels[data.status]??data.status}</Tag>}
    </div>
    <p className="agent-activity-note">每 2.5 秒更新 · 显示工具活动和可展示的输出</p>
    {error && <Alert type="warning" message={error}/>}
    {data?.activity && <p>{data.activity}</p>}
    {!data&&!error && <p role="status">正在读取运行过程…</p>}
    {data&&!data.items.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无可展示的活动"/>}
    {data?.items.map((item,i)=><div className="agent-activity-item" key={`${item.id}-${i}`}>
      <div><strong>{item.title}</strong><Tag>{labels[item.status]??item.status}</Tag></div>
      {item.text && <pre>{item.text}</pre>}
    </div>)}
  </div>;
}
