"""Turn Claude Code transcripts into one row per prompt. Local only; keeps no prompt text.

usage: python -I extract.py [projects_dir] [out.jsonl]
Kind and follow-up come from the plugin's own kindOf/followUp (classify.mjs, needs Node 22+).
Row: when, kind, prompt_len, arm (model·effort, the dominant one), msgs, tool_results, errors,
usd (list prices), follow ('redo'|'rephrase'|'ack'|'none'), gap_s (seconds to the next prompt).
"""
import collections
import glob
import json
import os
import re
import subprocess
import sys
from datetime import datetime

PROJECTS = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser('~/.claude/projects')
OUT = sys.argv[2] if len(sys.argv) > 2 else 'turns.jsonl'


# USD per million tokens: (in, out, cache read, cache write); first match wins
PRICES = [('haiku-5', (0.1, 0.5, 0.01, 0.125)), ('haiku', (1, 5, 0.1, 1.25)), ('sonnet-4', (3, 15, 0.3, 3.75)),
          ('sonnet', (2, 10, 0.2, 2.5)), ('fable', (10, 50, 0.25, 12.5)), ('opus-5-5', (4, 20, 0.2, 5)), ('opus', (5, 25, 0.5, 6.25))]


def price(model):
    for key, p in PRICES:
        if key in (model or ''):
            return p
    return None


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


def classify(texts, pairs):
    here = os.path.dirname(os.path.abspath(__file__))
    out = subprocess.run(['node', os.path.join(here, 'classify.mjs')], input=json.dumps({'texts': texts, 'pairs': pairs}),
                         capture_output=True, text=True, encoding='utf8', check=True)
    d = json.loads(out.stdout)
    return d['kinds'], d['follows']


pending = []  # (row without kind/follow, text, pair index or None)
texts, pairs = [], []
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
        gap, pi = None, None
        if nxt:
            try:
                gap = (when(nxt['when']) - when(tn['when'])).total_seconds()
            except ValueError:
                gap = None
            if gap is not None:
                pi = len(pairs)
                pairs.append([tn['text'], nxt['text'], gap * 1000])
        texts.append(tn['text'])
        pending.append(({'when': tn['when'], 'prompt_len': len(tn['text']), 'arm': tn['arms'].most_common(1)[0][0], 'msgs': tn['msgs'],
                         'tool_results': tn['tr'], 'errors': tn['err'], 'usd': round(tn['usd'], 4), 'gap_s': gap}, pi))

kinds, follows = classify(texts, pairs)
with open(OUT, 'w', encoding='utf8') as fh:
    for k, (r, pi) in zip(kinds, pending):
        r['kind'] = k
        r['follow'] = follows[pi] if pi is not None else 'none'
        fh.write(json.dumps(r, ensure_ascii=False) + chr(10))
print(len(pending), 'turns ->', OUT)
