"""Provision checksum-verified Temurin toolchains inside platform storage."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import platform
import re
import tarfile
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path


def download_jdk(cache, version):
    home=cache/f'jdk-{version}'
    ready=home/'ready.json'
    if ready.exists():
        record=json.loads(ready.read_text(encoding='utf-8'))
        java_home = Path(record['home'])
        if (java_home.is_relative_to(home)
                and any((java_home / 'bin' / name).is_file() for name in ('java', 'java.exe'))):
            return record
    home.mkdir(parents=True,exist_ok=True)
    arch={'AMD64':'x64','x86_64':'x64','arm64':'aarch64','aarch64':'aarch64'}.get(platform.machine())
    operating={'Darwin':'mac','Linux':'linux','Windows':'windows'}.get(platform.system())
    if not arch or not operating:raise RuntimeError('当前系统暂无JDK下载适配器')
    url=f'https://api.adoptium.net/v3/assets/latest/{version}/hotspot?architecture={arch}&image_type=jdk&os={operating}&vendor=eclipse'
    with urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'ai-project-factory/0.1','Accept':'application/json'}),timeout=45) as response:assets=json.load(response)
    package=assets[0]['binary']['package']
    if urllib.parse.urlsplit(package['link']).hostname not in {'github.com','api.adoptium.net'}:raise RuntimeError('JDK下载源不在允许列表')
    archive=home/'download.part';sha=hashlib.sha256()
    size=int(package['size'])
    if not 0<size<=500_000_000:raise RuntimeError('JDK文件大小不合法')
    def part(index):
        start=size*index//8;end=size*(index+1)//8-1
        path=home/f'part-{index}'
        request=urllib.request.Request(package['link'],headers={'User-Agent':'ai-project-factory/0.1','Range':f'bytes={start}-{end}'})
        with urllib.request.urlopen(request,timeout=60) as response,path.open('wb') as target:
            if response.status!=206 or response.headers.get('Content-Range')!=f'bytes {start}-{end}/{size}':raise RuntimeError('JDK下载服务器未返回请求的分段')
            count=0
            while chunk:=response.read(1024*1024):
                count+=len(chunk)
                if count>end-start+1:raise RuntimeError('JDK分段大小不符')
                target.write(chunk)
            if count!=end-start+1:raise RuntimeError('JDK分段下载不完整')
        return path
    with ThreadPoolExecutor(max_workers=8) as pool:parts=list(pool.map(part,range(8)))
    with archive.open('wb') as target:
        for path in parts:
            with path.open('rb') as source:
                while chunk:=source.read(1024*1024):sha.update(chunk);target.write(chunk)
            path.unlink()
    if sha.hexdigest()!=package['checksum']:raise RuntimeError('JDK校验和不匹配')
    extracted=home/'files';extracted.mkdir(exist_ok=True)
    if zipfile.is_zipfile(archive):
        with zipfile.ZipFile(archive) as bundle:
            for member in bundle.infolist():
                target = (extracted / member.filename).resolve()
                if not target.is_relative_to(extracted.resolve()):
                    raise RuntimeError('JDK压缩包包含非法路径')
                mode = (member.external_attr >> 16) & 0o170000
                if mode == 0o120000:
                    raise RuntimeError('JDK压缩包包含不受支持的链接')
            bundle.extractall(extracted)
    else:
        with tarfile.open(archive) as bundle:
            members = bundle.getmembers()
            for member in members:
                target = (extracted / member.name).resolve()
                if not target.is_relative_to(extracted.resolve()):
                    raise RuntimeError('JDK压缩包包含非法路径')
                if member.issym() or member.islnk():
                    raise RuntimeError('JDK压缩包包含不受支持的链接')
            try:
                bundle.extractall(extracted, filter='data')
            except TypeError:
                bundle.extractall(extracted, members=members)
    java=next((p for p in extracted.glob('**/bin/java*') if p.is_file()),None)
    if java is None:raise RuntimeError('下载包缺少java入口')
    record={'version':version,'home':str(java.parent.parent.resolve()),'sha256':sha.hexdigest(),'source':package['link']}
    ready.write_text(json.dumps(record), encoding='utf-8');archive.unlink()
    return record


async def ensure_toolchains(data_dir, source, offline, log):
    content='\n'.join(p.read_text(encoding='utf-8', errors='replace') for p in source.rglob('*.gradle.kts'))
    versions={int(v) for v in re.findall(r'JavaLanguageVersion\.of\(\s*(\d+)',content)}
    # A Kotlin convention behind withPlugin does not require its JDK in a Java-only project.
    kotlin_applied=any(source.rglob('*.kt')) or any(
        re.search(r'(?:kotlin\("jvm"\)|id\("org.jetbrains.kotlin.jvm"\))',line) and 'apply false' not in line
        for p in source.rglob('*.gradle.kts') if p.name!='settings.gradle.kts' for line in p.read_text(encoding='utf-8', errors='replace').splitlines())
    if kotlin_applied:versions.update(int(v) for v in re.findall(r'jvmToolchain\(\s*(\d+)',content))
    versions=sorted(versions)
    records=[]
    for version in versions:
        if version not in {17,21}:raise RuntimeError(f'AI 团队要求JDK {version}，尚未支持自动安装')
        cache=data_dir/'toolchains'
        if offline and not (cache/f'jdk-{version}/ready.json').exists():
            await log(f'离线模式未配置JDK {version}，交给构建报告真实环境状态');continue
        await log(f'平台准备JDK {version}：读取官方元数据、校验下载文件并绑定本地目录')
        record=await asyncio.to_thread(download_jdk,cache,version)
        records.append(record)
    return records
