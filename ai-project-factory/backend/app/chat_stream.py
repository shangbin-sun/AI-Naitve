"""Shared structured-reply decoding and per-session configuration helpers."""
import json

def partial_reply(raw, on_complete=None):
    """Decode only the top-level reply string, never expose draft JSON or escapes."""
    decoder = json.JSONDecoder()
    pos = 0
    try:
        pos = raw.index('{') + 1
        while True:
            while pos < len(raw) and raw[pos] in ' \r\n\t,':
                pos += 1
            key, pos = decoder.raw_decode(raw, pos)
            while pos < len(raw) and raw[pos].isspace():
                pos += 1
            if raw[pos] != ':':
                return ''
            pos += 1
            while pos < len(raw) and raw[pos].isspace():
                pos += 1
            if key != 'reply':
                _, pos = decoder.raw_decode(raw, pos)
                continue
            if raw[pos] != '"':
                return ''
            start = pos
            pos += 1
            while pos < len(raw):
                if raw[pos] == '"':
                    result = decoder.raw_decode(raw, start)[0]
                    if on_complete:
                        on_complete()
                    return result
                if raw[pos] == '\\':
                    width = 6 if raw[pos:pos+2] == '\\u' else 2
                    if pos + width > len(raw):
                        break
                    # Keep UTF-16 surrogate pairs together.
                    if width == 6 and 0xD800 <= int(raw[pos+2:pos+6], 16) <= 0xDBFF:
                        if pos + 12 > len(raw):
                            break
                        width = 12
                    pos += width
                else:
                    pos += 1
            return json.loads(raw[start:pos] + '"')
    except (ValueError, IndexError, TypeError):
        return ''


def lean_config(effective, catalog):
    """Per-thread overrides only; never write the user's Codex configuration."""
    skills = [skill for entry in catalog.get('data', []) for skill in entry.get('skills', [])]
    return {
        'web_search': 'disabled', 'project_doc_max_bytes': 0,
        'developer_instructions': '',
        'features': {'shell_tool': False, 'multi_agent': False, 'js_repl': False,
                     'apps': False, 'memories': False},
        'tools': {'view_image': False},
        'mcp_servers': {name: {'enabled': False} for name in effective.get('mcp_servers', {})},
        'plugins': {name: {'enabled': False} for name in effective.get('plugins', {})},
        'skills': {'config': [{'path': skill['path'], 'enabled': False} for skill in skills]},
    }
