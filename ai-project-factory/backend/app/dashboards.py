"""Versioned, read-only generated dashboards; separate from organization editing."""
import hashlib
import html
import json
import secrets
from html.parser import HTMLParser
from pathlib import PurePosixPath

from fastapi import HTTPException, Response
from jsonschema import Draft202012Validator, ValidationError, SchemaError
from referencing import Registry
from referencing.exceptions import NoSuchResource, Unresolvable
from pydantic import BaseModel, Field
from sqlalchemy import JSON, ForeignKey, String, Integer, select, update, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .models import Base, uid, now
from .service import get_design
from .workspaces import safe_path


class Dashboard(Base):
    __tablename__ = 'dashboards'
    project_id: Mapped[str] = mapped_column(ForeignKey('designs.id'), primary_key=True)
    version: Mapped[int] = mapped_column(Integer)
    payload: Mapped[dict] = mapped_column(JSON)


class DashboardRevision(Base):
    __tablename__ = 'dashboard_revisions'
    __table_args__ = (UniqueConstraint('project_id','version'),)
    id: Mapped[str] = mapped_column(String, primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(ForeignKey('designs.id'), index=True)
    version: Mapped[int] = mapped_column(Integer)
    payload: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[str] = mapped_column(String, default=now)


class SaveDashboard(BaseModel):
    expected_version: int = Field(ge=0)
    title: str = Field(min_length=1, max_length=100)
    files: dict[str, str]
    data_schema: dict = Field(default_factory=lambda:{'type':'object'})
    sample_data: dict = Field(default_factory=dict)
    # Empty node selects the platform's standard execution summary.
    data_node: str = ''
    data_file: str = 'dashboard.json'


def current_dashboard(db, project):
    row = db.get(Dashboard, project)
    return {'version':row.version, **row.payload} if row else None


def validate_data(schema, data):
    def unavailable(uri):
        raise NoSuchResource(ref=uri)
    try:
        Draft202012Validator.check_schema(schema)
        Draft202012Validator(schema, registry=Registry(retrieve=unavailable)).validate(data)
    except (ValidationError, SchemaError, Unresolvable) as error:
        raise HTTPException(422, '看板数据与 schema 不匹配：' + str(error)[:400]) from error


class PageCompiler(HTMLParser):
    """Compile local JS/CSS into a single page; forbid navigation and nested frames."""
    def __init__(self, files, nonce):
        super().__init__(convert_charrefs=False)
        self.files, self.nonce, self.output = files, nonce, []

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag == 'meta':
            if 'charset' in values or values.get('name') == 'viewport': return
            raise ValueError('看板不支持跳转或自定义策略 meta 标签')
        if tag in ('iframe','frame','object','embed','base','form'):
            raise ValueError(f'看板不支持 {tag} 标签')
        if any(k.lower().startswith('on') for k,v in attrs):
            raise ValueError('请使用 addEventListener 绑定交互')
        if tag == 'script':
            if values.get('src'):
                source = values['src']
                if source not in self.files or not source.endswith('.js'):
                    raise ValueError('JavaScript 必须来自页面包内的 .js 文件')
                code = self.files[source].replace('</script', '<\\/script')
                self.output.append(f'<script nonce="{self.nonce}">{code}')
                return
            attrs = [(k,v) for k,v in attrs if k != 'nonce'] + [('nonce',self.nonce)]
        if tag == 'link':
            source = values.get('href')
            if values.get('rel') != 'stylesheet' or source not in self.files or not source.endswith('.css'):
                raise ValueError('样式表必须来自页面包内的 .css 文件')
            self.output.append('<style>' + self.files[source].replace('</style','<\\/style') + '</style>')
            return
        for key,value in attrs:
            if key in ('href','action','formaction','srcset','ping') and value:
                if key != 'href' or not value.startswith('#'):
                    raise ValueError('看板内不允许页面跳转、表单或外部资源')
            if key == 'src' and value and not value.startswith('data:image/'):
                raise ValueError('图片请使用内嵌 data:image 资源')
        self.output.append('<'+tag+''.join(' '+k+(('="'+html.escape(v, quote=True)+'"') if v is not None else '') for k,v in attrs)+'>')

    def handle_startendtag(self, tag, attrs): self.handle_starttag(tag, attrs)
    def handle_endtag(self, tag): self.output.append('</'+tag+'>')
    def handle_data(self, data): self.output.append(data)
    def handle_entityref(self, name): self.output.append('&'+name+';')
    def handle_charref(self, name): self.output.append('&#'+name+';')
    def handle_decl(self, decl): self.output.append('<!'+decl+'>')
    def handle_comment(self, data): pass


def compile_page(payload, data, nonce):
    parser = PageCompiler(payload['files'], nonce)
    try:
        parser.feed(payload['files']['index.html']); parser.close()
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    encoded = json.dumps(data, ensure_ascii=True).replace('<','\\u003c').replace('>','\\u003e').replace('&','\\u0026')
    return f'<script nonce="{nonce}">window.DASHBOARD_DATA={encoded};</script>' + ''.join(parser.output)


def save_dashboard(db, project, data):
    design = get_design(db, project)
    if data.data_node and data.data_node not in {step['key'] for step in (design.draft or {}).get('workflow', [])}:
        raise HTTPException(422, '请选择当前工作流中的数据节点')
    if PurePosixPath(data.data_file).name != data.data_file or not data.data_file.endswith('.json') or '\\' in data.data_file:
        raise HTTPException(422, '数据文件应为 JSON 文件名')
    if 'index.html' not in data.files or len(data.files)>20:
        raise HTTPException(422, '页面包必须包含 index.html，最多20个文件')
    if sum(len(v.encode()) for v in data.files.values()) > 1_000_000:
        raise HTTPException(422, '页面包不能超过1MB')
    for name in data.files:
        path=PurePosixPath(name)
        if path.is_absolute() or '..' in path.parts or '\\' in name or path.suffix not in ('.html','.css','.js'):
            raise HTTPException(422, '看板只接受包内 HTML、CSS、JavaScript 文件')
    # Local schemas only: validation must never fetch a remote reference.
    def check_refs(value):
        if isinstance(value,dict):
            for k,v in value.items():
                if k in ('$ref','$dynamicRef') and (not isinstance(v,str) or not v.startswith('#')):
                    raise HTTPException(422,'schema 只能引用内部定义')
                check_refs(v)
        elif isinstance(value,list):
            for v in value: check_refs(v)
    check_refs(data.data_schema)
    payload=data.model_dump(exclude={'expected_version'})
    if len(json.dumps(payload['data_schema']).encode())>100_000 or len(json.dumps(payload['sample_data']).encode())>1_000_000:
        raise HTTPException(422,'schema 或样例数据过大')
    validate_data(data.data_schema, data.sample_data)
    compile_page(payload, data.sample_data, 'validation')
    row=db.get(Dashboard,project)
    version=data.expected_version+1
    if row:
        changed=db.execute(update(Dashboard).where(Dashboard.project_id==project,Dashboard.version==data.expected_version).values(version=version,payload=payload))
        if changed.rowcount != 1: raise HTTPException(409,'看板已更新，请重新读取版本')
    elif data.expected_version != 0:
        raise HTTPException(409,'看板版本不一致')
    else:
        db.add(Dashboard(project_id=project,version=version,payload=payload))
    db.add(DashboardRevision(project_id=project,version=version,payload=payload))
    db.flush()
    return {'version':version, **payload}


class DashboardService:
    def __init__(self,sessions,runs): self.sessions,self.runs=sessions,runs

    def view(self, project, run_id=None, version=None):
        with self.sessions() as db:
            get_design(db,project)
            if not run_id:
                row=db.scalar(select(DashboardRevision).where(DashboardRevision.project_id==project,DashboardRevision.version==version)) if version is not None else None
                payload=({'version':row.version, **row.payload} if row else None) if version is not None else current_dashboard(db,project)
                if not payload: raise HTTPException(404,'此 AI 团队尚未生成看板')
                return payload,payload['sample_data'],'配置预览 · 样例数据'
            task,run=self.runs.rows(db,project,run_id)
            payload=run.snapshot['definition'].get('dashboard')
            if not payload: raise HTTPException(404,'本次运行未绑定看板版本；新建运行后生效')
            if payload.get('data_node'):
                node=run.state['nodes'].get(payload['data_node'])
                artifacts=[a for a in (node or {}).get('artifacts',[]) if a['path'].endswith('/'+payload['data_file'])]
                if len(artifacts)!=1: raise HTTPException(422,'尚无唯一且已登记的看板数据文件')
                artifact=artifacts[0]
                path=safe_path(self.runs.directory(task,run),artifact['path'])
                try:
                    if path.stat().st_size>1_000_000: raise HTTPException(422,'看板数据不能超过1MB')
                    raw=path.read_bytes()
                except OSError as error:
                    raise HTTPException(422,'看板数据文件不可读取') from error
                if hashlib.sha256(raw).hexdigest()!=artifact['sha256']: raise HTTPException(409,'看板数据文件已变化，请重新验证')
                try: data=json.loads(raw)
                except (ValueError,UnicodeError): raise HTTPException(422,'看板产物不是有效JSON')
            else:
                data={'run':{'id':run.id,'title':task.title,'status':run.status},
                      'nodes':[{'key':key,'name':node['step']['name'],'employee':node['employee']['name'],
                                'status':node['status'],'artifacts':node['artifacts']} for key,node in run.state['nodes'].items()]}
            validate_data(payload['data_schema'],data)
            return payload,data,'运行数据'


def install_dashboards(app,service):
    @app.get('/api/workspaces/{project}/dashboard')
    def get(project:str):
        with service.sessions() as db:
            get_design(db,project)
            revisions=db.scalars(select(DashboardRevision).where(DashboardRevision.project_id==project).order_by(DashboardRevision.version.desc())).all()
            return {'dashboard':current_dashboard(db,project), 'contract':SaveDashboard.model_json_schema(),
                    'versions':[{'version':r.version,'title':r.payload['title']} for r in revisions]}

    @app.get('/api/workspaces/{project}/dashboard/preview')
    def preview(project:str,run_id:str|None=None,version:int|None=None):
        payload,data,label=service.view(project,run_id,version)
        return {'version':payload['version'],'title':payload['title'],'label':label}

    @app.get('/api/workspaces/{project}/dashboard/frame')
    def frame(project:str,run_id:str|None=None,version:int|None=None):
        payload,_,_=service.view(project,run_id,version)
        from urllib.parse import urlencode
        query='?'+urlencode({'run_id':run_id} if run_id else {'version':payload['version']})
        page=f'<!doctype html><html><body style="margin:0"><iframe title="看板页面" sandbox="allow-scripts" referrerpolicy="no-referrer" src="/api/workspaces/{html.escape(project)}/dashboard/page{query}" style="border:0;width:100%;height:100vh"></iframe></body></html>'
        return Response(page,media_type='text/html',headers={'Content-Security-Policy':"default-src 'none'; frame-src 'self'; style-src 'unsafe-inline'; sandbox allow-scripts",'Cache-Control':'no-store'})

    @app.get('/api/workspaces/{project}/dashboard/page')
    def page(project:str,run_id:str|None=None,version:int|None=None):
        payload,data,_=service.view(project,run_id,version)
        nonce=secrets.token_urlsafe(24)
        return Response(compile_page(payload,data,nonce),media_type='text/html',headers={
            'Content-Security-Policy':f"sandbox allow-scripts; default-src 'none'; script-src 'nonce-{nonce}'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'",
            'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'})
