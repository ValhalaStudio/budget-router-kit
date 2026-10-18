"""Turn Claude Code transcripts into one row per prompt. Local only; keeps no prompt text.

usage: python -I extract.py [projects_dir] [out.jsonl]
Row: when, kind, prompt_len, arm (model·effort, the dominant one), msgs, tool_results, errors,
usd (list prices), follow ('redo'|'rephrase'|'ack'|'none'), gap_s (seconds to the next prompt).
"""
import collections
import glob
import json
import os
import re
import sys
from datetime import datetime

PROJECTS = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser('~/.claude/projects')
OUT = sys.argv[2] if len(sys.argv) > 2 else 'turns.jsonl'

DOMAINS = [
    ('unreal', r'unreal|\bue ?[45]\b|uproject|blueprint|uasset|\bubt\b|lyra|niagara|pilgerweg'),
    ('git', r'\bgit\b|commit|branch|merge|pull request|\bpush\b|rebase'),
    ('docs', r'readme|documentation|write[- ]?up|explain|summar|diagram|report'),
    ('system', r'disk|storage|drive|folder|install|uninstall|delete|move|junction|registry|service'),
    ('code', r'function|\bbug\b|refactor|\btest|compile|class\b|stack ?trace|\berror\b|implement|plugin'),
]
REDO = re.compile(r"^\s*(no\b|nope|wrong|that'?s (not|wrong)|not what i|still (broken|failing|not|wrong)|again\b|try again|redo|you (missed|forgot|didn'?t)|doesn'?t work|didn'?t work|it'?s still)", re.I)
THANKS = re.compile(r'^\s*(thanks|thank you|thx|perfect|great|works|it works|nice|awesome|that worked|good job|looks good|lgtm)\b', re.I)

# USD per million tokens: (in, out, cache read, cache write); first match wins
PRICES = [('haiku-5', (0.1, 0.5, 0.01, 0.125)), ('haiku', (1, 5, 0.1, 1.25)), ('sonnet-4', (3, 15, 0.3, 3.75)),
          ('sonnet', (2, 10, 0.2, 2.5)), ('fable', (10, 50, 0.25, 12.5)), ('opus-5-5', (4, 20, 0.2, 5)), ('opus', (5, 25, 0.5, 6.25))]


def price(model):
    for key, p in PRICES:
        if key in (model or ''):
            return p
    return None


def kind(text):
    t = text[:800]
    for name, rx in DOMAINS:
        if re.search(rx, t, re.I):
            return name
    return 'general'


def tri(s):
    s = re.sub(r'\s+', ' ', s.lower()).strip()
    return {s[i:i + 3] for i in range(len(s) - 2)}


def dice(a, b):
    x, y = tri(a), tri(b)
    return 2 * len(x & y) / (len(x) + len(y)) if x and y else 0.0


def prompt_text(d):
    c = d.get('message', {}).get('content')
    if isinstance(c, str) and c.strip() and not c.lstrip().startswith('<'):
        return c
    if isinstance(c, list) and c and all(b.get('type') == 'text' for b in c):
        t = ' '.join(b.get('text', '') for b in c)
        return t if t.strip() and not t.lstrip().startswith('<') else None
    return None


def when(ts):
    return datetime.fromisoformat(ts.replace('Z', '+00:00'))


rows = []
for f in glob.glob(os.path.join(PROJECTS, '**', '*.jsonl'), recursive=True):
    cur = None
    turns = []
    for line in open(f, encoding='utf8', errors='ignore'):
        try:
            d = json.loads(line)
        except ValueError:
            continue
        if d.get('isSidechain'):
            continue
        t = d.get('type')
        if t == 'user':
            txt = prompt_text(d)
            if txt is not None:
                cur = {'text': txt, 'when': d.get('timestamp', ''), 'arms': collections.Counter(), 'msgs': 0, 'tr': 0, 'err': 0, 'usd': 0.0}
                turns.append(cur)
            elif cur is not None and isinstance(d.get('message', {}).get('content'), list):
                for b in d['message']['content']:
                    if b.get('type') == 'tool_result':
                        cur['tr'] += 1
                        cur['err'] += 1 if b.get('is_error') else 0
        elif t == 'assistant' and cur is not None:
            m = d.get('message', {})
            p = price(m.get('model'))
            u = m.get('usage') or {}
            if p:
                cur['msgs'] += 1
                cur['arms'][f"{m.get('model')}·{d.get('effort')}"] += 1
                cur['usd'] += (u.get('input_tokens', 0) * p[0] + u.get('output_tokens', 0) * p[1]
                               + u.get('cache_read_input_tokens', 0) * p[2] + u.get('cache_creation_input_tokens', 0) * p[3]) / 1e6
    for i, tn in enumerate(turns):
        if not tn['msgs']:
            continue
        nxt = turns[i + 1] if i + 1 < len(turns) else None
        follow, gap = 'none', None
        if nxt:
            try:
                gap = (when(nxt['when']) - when(tn['when'])).total_seconds()
            except ValueError:
                gap = None
            if REDO.search(nxt['text']):
                follow = 'redo'
            elif gap is not None and gap < 240 and len(tn['text']) > 20 and len(nxt['text']) > 20 and dice(tn['text'], nxt['text']) > 0.6:
                follow = 'rephrase'
            elif gap is not None and gap < 900 and THANKS.search(nxt['text']) and len(nxt['text']) < 80:
                follow = 'ack'
        rows.append({'when': tn['when'], 'kind': kind(tn['text']), 'prompt_len': len(tn['text']), 'arm': tn['arms'].most_common(1)[0][0],
                     'msgs': tn['msgs'], 'tool_results': tn['tr'], 'errors': tn['err'], 'usd': round(tn['usd'], 4), 'follow': follow, 'gap_s': gap})

with open(OUT, 'w', encoding='utf8') as fh:
    for r in rows:
        fh.write(json.dumps(r) + '\n')
print(len(rows), 'turns ->', OUT)
