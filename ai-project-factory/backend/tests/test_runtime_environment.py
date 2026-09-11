import json
import os
from pathlib import Path
import subprocess

import pytest
from app.runtime_environment import runtime_environment, runtime_config


def test_real_python_and_zsh_use_private_temporary_directory(tmp_path):
    directory=tmp_path/'run'/'employee'/'attempt';directory.mkdir(parents=True)
    env=runtime_environment(directory)
    code='import tempfile,json; f=tempfile.NamedTemporaryFile(); print(json.dumps({"tmp":tempfile.gettempdir(),"file":f.name}))'
    import sys
    output=subprocess.check_output([sys.executable,'-c',code],env={**os.environ,**env},text=True)
    result=json.loads(output)
    assert result['tmp']==env['TMPDIR']
    assert Path(result['file']).parent==Path(env['TMPDIR'])
    zsh=Path('/bin/zsh')
    if zsh.exists():
        result=subprocess.check_output([str(zsh),'-f','-c','cat <<EOF\nhello\nEOF\nprint -r -- "$TMPPREFIX"'],env={**os.environ,**env},text=True)
        assert result=='hello\n'+env['TMPPREFIX']+'\n'
    assert Path(env['TMPDIR']).stat().st_mode & 0o777 == 0o700


def test_attempt_isolation_resume_and_symlink_rejection(tmp_path):
    first=runtime_environment(tmp_path/'first')
    marker=Path(first['TMPDIR'])/'recover';marker.write_text('keep')
    assert runtime_environment(tmp_path/'first')==first and marker.read_text()=='keep'
    second=runtime_environment(tmp_path/'second')
    assert first['TMPDIR']!=second['TMPDIR']
    (tmp_path/'unsafe').mkdir();(tmp_path/'unsafe'/'.runtime').symlink_to(tmp_path/'first',target_is_directory=True)
    with pytest.raises(ValueError): runtime_environment(tmp_path/'unsafe')
    config=runtime_config({'shell_environment_policy':{'set':{'KEEP':'yes'}},'features':{'multi_agent':False}},first)
    assert config['shell_environment_policy']['set']['KEEP']=='yes'
    assert config['shell_environment_policy']['set']['TEMP']==first['TEMP']
