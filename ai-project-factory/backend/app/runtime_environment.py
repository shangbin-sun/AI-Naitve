"""Temporary resources stay inside the existing execution write boundary."""
from .workspaces import safe_path


def runtime_environment(directory):
    directory = directory.resolve()
    paths = {name: safe_path(directory, '.runtime/' + name) for name in ('tmp', 'cache')}
    for path in paths.values():
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
        path.chmod(0o700)
    tmp, cache = str(paths['tmp']), str(paths['cache'])
    return {'TMPDIR': tmp, 'TMP': tmp, 'TEMP': tmp, 'TMPPREFIX': tmp + '/zsh',
            'XDG_CACHE_HOME': cache, 'PIP_CACHE_DIR': cache + '/pip',
            'UV_CACHE_DIR': cache + '/uv', 'RUFF_CACHE_DIR': cache + '/ruff',
            'MPLCONFIGDIR': cache + '/matplotlib', 'PYTHONPYCACHEPREFIX': cache + '/pycache'}


def runtime_config(config, environment):
    return {**config, 'shell_environment_policy': {
        **config.get('shell_environment_policy', {}), 'set': {
            **config.get('shell_environment_policy', {}).get('set', {}), **environment}}}
