import hashlib
import io
import json
import tarfile

import pytest
from app.toolchains import download_jdk


@pytest.mark.parametrize('corrupt',[False,True])
def test_toolchain_segments_verified_before_use(tmp_path,monkeypatch,corrupt):
    raw=io.BytesIO()
    with tarfile.open(fileobj=raw,mode='w:gz') as archive:
        content=b'java fixture';info=tarfile.TarInfo('jdk/bin/java');info.size=len(content)
        archive.addfile(info,io.BytesIO(content))
    data=raw.getvalue()
    checksum='0'*64 if corrupt else hashlib.sha256(data).hexdigest()
    metadata=[{'binary':{'package':{'link':'https://github.com/adoptium/fixture','size':len(data),'checksum':checksum}}}]
    class Response(io.BytesIO):
        status=200
        headers={}
    def fetch(request,timeout):
        if 'api.adoptium.net' in request.full_url:return Response(json.dumps(metadata).encode())
        start,end=map(int,request.get_header('Range').removeprefix('bytes=').split('-'))
        response=Response(data[start:end+1]);response.status=206;response.headers={'Content-Range':f'bytes {start}-{end}/{len(data)}'}
        return response
    monkeypatch.setattr('urllib.request.urlopen',fetch)
    if corrupt:
        with pytest.raises(RuntimeError,match='校验和'):download_jdk(tmp_path,17)
        assert not (tmp_path/'jdk-17/ready.json').exists()
    else:
        record=download_jdk(tmp_path,17)
        assert record['sha256']==checksum
        monkeypatch.setattr('urllib.request.urlopen',lambda *a,**k:pytest.fail('cached runtime must not download'))
        assert download_jdk(tmp_path,17)==record


def test_java_only_project_does_not_install_inactive_kotlin_toolchain(tmp_path,monkeypatch):
    import asyncio
    from app.toolchains import ensure_toolchains
    source=tmp_path/'source';source.mkdir()
    (source/'build.gradle.kts').write_text('kotlin("jvm") version "2.3.0" apply false\nJavaLanguageVersion.of(17)\npluginManager.withPlugin("org.jetbrains.kotlin.jvm") { jvmToolchain(21) }')
    (source/'settings.gradle.kts').write_text('kotlin("jvm") version "2.3.0"')
    calls=[]
    def download(cache,version):calls.append(version);return {'version':version,'home':'fixture'}
    monkeypatch.setattr('app.toolchains.download_jdk',download)
    async def log(text):pass
    asyncio.run(ensure_toolchains(tmp_path,source,False,log))
    assert calls==[17]
