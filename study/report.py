#!/usr/bin/env python3
"""Offline usage report with conclusions, from your own Claude Code transcripts and the budget-router store.

usage: python -I study/report.py [--days 30] [--projects DIR] [--store FILE] [--out study/out/report.html]

Reads ~/.claude/projects/**/*.jsonl (your transcripts) and the plugin's store file. Writes one HTML file on
your machine. Nothing is sent anywhere, no prompt text is kept (only lengths), and the plugin never runs this.
Costs are estimates at list prices (cached in PRICES below), not an invoice: on a subscription they measure
usage, not billing. A request appears on several transcript lines (one per content block); each is counted once.
"""
import argparse
import collections
import glob
import html
import json
import os
import statistics
import sys
from datetime import datetime, timedelta, timezone

# USD per million tokens: (input, output, cache read, cache write); first match wins. Mirrors hooks/smart.ts.
PRICES = [('haiku-5', (0.1, 0.5, 0.01, 0.125)), ('haiku', (1, 5, 0.1, 1.25)), ('sonnet-4', (3, 15, 0.3, 3.75)),
          ('sonnet', (2, 10, 0.2, 2.5)), ('fable', (10, 50, 0.25, 12.5)), ('mythos', (10, 50, 0.25, 12.5)),
          ('opus-5-5', (4, 20, 0.2, 5)), ('opus', (5, 25, 0.5, 6.25))]
ASSUMED_EFFORT_OUT = {'low': 0.7, 'medium': 1.0, 'high': 1.4, 'xhigh': 1.9, 'max': 2.6}  # the learner's cost guess (smart.ts)
CACHE_TTL_S = 3600  # a subscription's prompt cache; after a longer pause the context is re-written
EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']


def family(model):
    m = (model or '').lower()
    for f in ('haiku', 'sonnet', 'opus', 'fable', 'mythos'):
        if f in m:
            return f
    return None


def price(model):
    for key, p in PRICES:
        if key in (model or ''):
            return p
    return None


def parse_ts(ts):
    try:
        t = datetime.fromisoformat(ts.replace('Z', '+00:00'))
    except (ValueError, AttributeError):
        return None
    # A timestamp without a zone is taken as UTC, so it can be compared with the aware cut-off.
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def dedup_key(d):
    """A request's identity: its requestId and message id. None when either is missing (such lines are not merged)."""
    rid, mid = d.get('requestId'), (d.get('message') or {}).get('id')
    return (rid, mid) if rid is not None and mid is not None else None


def prompt_len(d):
    c = d.get('message', {}).get('content')
    if isinstance(c, str) and c.strip() and not c.lstrip().startswith('<'):
        return len(c)
    if isinstance(c, list) and c and all(b.get('type') == 'text' for b in c):
        t = ' '.join(b.get('text', '') for b in c)
        return len(t) if t.strip() and not t.lstrip().startswith('<') else None
    return None


def load(projects, since):
    """Every priced request once, grouped into main-conversation turns."""
    reqs, turns = [], []
    for path in glob.glob(os.path.join(projects, '**', '*.jsonl'), recursive=True):
        lines = []
        for raw in open(path, encoding='utf8', errors='ignore'):
            try:
                lines.append(json.loads(raw))
            except ValueError:
                lines.append({})
        last = {}
        for i, d in enumerate(lines):
            if d.get('type') == 'assistant' and dedup_key(d) is not None:
                last[dedup_key(d)] = i
        sess = os.path.basename(path)
        turn = None
        for i, d in enumerate(lines):
            t = d.get('type')
            if t == 'user' and not d.get('isSidechain'):
                n = prompt_len(d)
                if n is not None:
                    turn = {'sess': sess, 'ts': parse_ts(d.get('timestamp')), 'len': n, 'reqs': [], 'errors': 0}
                    turns.append(turn)
                elif turn is not None and isinstance(d.get('message', {}).get('content'), list):
                    turn['errors'] += sum(1 for b in d['message']['content'] if b.get('type') == 'tool_result' and b.get('is_error'))
            elif t == 'assistant' and (dedup_key(d) is None or last.get(dedup_key(d)) == i):
                m = d.get('message') or {}
                u = m.get('usage') or {}
                p = price(m.get('model'))
                ts = parse_ts(d.get('timestamp'))
                if not p or ts is None or (since and ts < since):
                    continue
                inp, out = u.get('input_tokens', 0), u.get('output_tokens', 0)
                cr, cc = u.get('cache_read_input_tokens', 0), u.get('cache_creation_input_tokens', 0)
                r = {'sess': sess, 'ts': ts, 'model': m.get('model'), 'family': family(m.get('model')), 'effort': d.get('effort'),
                     'inp': inp, 'out': out, 'cr': cr, 'cc': cc, 'side': bool(d.get('isSidechain')),
                     'think': (u.get('output_tokens_details') or {}).get('thinking_tokens', 0),
                     'c_inp': inp * p[0] / 1e6, 'c_out': out * p[1] / 1e6, 'c_cr': cr * p[2] / 1e6, 'c_cc': cc * p[3] / 1e6}
                r['cost'] = r['c_inp'] + r['c_out'] + r['c_cr'] + r['c_cc']
                reqs.append(r)
                if not r['side'] and turn is not None:
                    turn['reqs'].append(r)
    turns = [t for t in turns if t['reqs']]
    return reqs, turns


def pct(a, b):
    return 100.0 * a / b if b else 0.0


def usd(x):
    return f'${x:,.2f}' if x < 100 else f'${x:,.0f}'


def analyse(reqs, turns):
    a = {}
    total = sum(r['cost'] for r in reqs)
    a['total'] = total
    a['n_req'] = len(reqs)
    a['n_turns'] = len(turns)
    parts = {k: sum(r[k] for r in reqs) for k in ('c_cr', 'c_cc', 'c_out', 'c_inp')}
    a['parts'] = parts
    side = sum(r['cost'] for r in reqs if r['side'])
    a['side'] = side
    by_model = collections.defaultdict(lambda: [0, 0.0])
    for r in reqs:
        by_model[r['family'] or 'other'][0] += 1
        by_model[r['family'] or 'other'][1] += r['cost']
    a['by_model'] = dict(by_model)
    by_day = collections.defaultdict(float)
    for r in reqs:
        by_day[r['ts'].astimezone().strftime('%Y-%m-%d')] += r['cost']
    a['by_day'] = dict(sorted(by_day.items()))
    # turns
    tc = sorted((sum(r['cost'] for r in t['reqs']) for t in turns), reverse=True)
    main_total = sum(tc)
    a['turn_median'] = statistics.median(tc) if tc else 0
    top = tc[: max(1, len(tc) // 20)]
    a['top5_share'] = pct(sum(top), main_total)
    longs = [t for t in turns if len(t['reqs']) >= 30]
    a['long_turns'] = len(longs)
    long_cost = sum(sum(r['cost'] for r in t['reqs']) for t in longs)
    a['long_share'] = pct(long_cost, main_total)  # share of main-chat spend
    a['long_share_total'] = pct(long_cost, total)  # share of all spend, same basis as the subagent share
    bad = [t for t in turns if t['errors'] >= 3]
    a['bad_turns'] = len(bad)
    a['bad_share'] = pct(sum(sum(r['cost'] for r in t['reqs']) for t in bad), main_total)
    # context size per request
    ctx = sorted(r['inp'] + r['cr'] + r['cc'] for r in reqs if not r['side'])
    a['ctx_median'] = statistics.median(ctx) if ctx else 0
    a['ctx_p90'] = ctx[int(len(ctx) * 0.9)] if ctx else 0
    # pauses: the first request after a gap longer than the cache lives re-writes the context
    rebuild, n_rebuild = 0.0, 0
    per = collections.defaultdict(list)
    for r in reqs:
        if not r['side']:
            per[r['sess']].append(r)
    for rs in per.values():
        rs.sort(key=lambda r: r['ts'])
        for prev, cur in zip(rs, rs[1:]):
            if (cur['ts'] - prev['ts']).total_seconds() > CACHE_TTL_S and cur['cc'] > 20_000:
                rebuild += cur['c_cc']
                n_rebuild += 1
    a['rebuild'], a['n_rebuild'] = rebuild, n_rebuild
    # dear model on simple work
    opus_turns = [t for t in turns if any(r['family'] == 'opus' for r in t['reqs'])]
    simple = [t for t in opus_turns if t['len'] < 200 and len(t['reqs']) <= 4 and t['errors'] == 0]
    ocost = sum(sum(r['cost'] for r in t['reqs']) for t in opus_turns)
    scost = sum(sum(r['cost'] for r in t['reqs']) for t in simple)
    a['opus_turns'], a['opus_cost'], a['opus_simple'], a['opus_simple_cost'] = len(opus_turns), ocost, len(simple), scost
    # measured effort ranking per model family (requests of the main conversation and subagents)
    grid = collections.defaultdict(list)
    for r in reqs:
        if r['family'] in ('haiku', 'sonnet', 'opus') and r['effort'] in EFFORTS:
            grid[(r['family'], r['effort'])].append(r)
    rank = {}
    for (fam, eff), rs in grid.items():
        outs = [r['out'] for r in rs]
        rank[(fam, eff)] = {'n': len(rs), 'out': statistics.mean(outs), 'out_med': statistics.median(outs),
                            'think': statistics.mean(r['think'] for r in rs), 'cost': statistics.mean(r['cost'] for r in rs),
                            'c_out': statistics.mean(r['c_out'] for r in rs)}
    a['rank'] = rank
    a['effort_mix'] = collections.Counter(r['effort'] for r in reqs if r['effort'])
    return a


def load_store(path):
    cands = [path] if path else sorted(glob.glob(os.path.expanduser('~/.claude/plugins/store/budget-router_*.json')), key=os.path.getmtime, reverse=True)
    best = None
    for p in cands:
        try:
            s = json.load(open(p, encoding='utf8')).get('smart')
        except (OSError, ValueError):
            continue
        if s and (best is None or s.get('seen', 0) > best.get('seen', 0)):
            best = s
    return best


def conclusions(a, store):
    out = []
    t = a['total'] or 1
    cr, cc = pct(a['parts']['c_cr'], t), pct(a['parts']['c_cc'], t)
    if cr + cc >= 50:
        out.append(('Most of your usage is the conversation being re-read, not new work',
                    f"Cache reads are {cr:.0f}% and cache writes {cc:.0f}% of estimated spend; fresh output is only {pct(a['parts']['c_out'], t):.0f}%. The median request carries {a['ctx_median'] / 1000:.0f}k tokens of context (90th percentile {a['ctx_p90'] / 1000:.0f}k).",
                    'Shrink the conversation before anything else: /clear between unrelated tasks, /compact with a focus before it gets huge, and let subagents do wide reads so only a summary lands in the main chat.'))
    if a['top5_share'] >= 35:
        out.append((f"A few long turns dominate: the dearest 5% of turns are {a['top5_share']:.0f}% of main-chat spend",
                    f"{a['long_turns']} turns made 30 or more requests and account for {a['long_share']:.0f}% of main-chat spend.",
                    'Cut long agentic turns down: plan first (Shift+Tab), name the files (@path), hand searches to a subagent, and stop and /rewind when a turn is going badly.'))
    if a['n_rebuild'] and pct(a['rebuild'], t) >= 2:
        out.append((f"Pauses cost you about {usd(a['rebuild'])} ({pct(a['rebuild'], t):.0f}% of spend)",
                    f"{a['n_rebuild']} times you came back after more than an hour and the first request re-wrote 20k+ tokens of context from scratch (upper bound: some of it was new content).",
                    'Before a break, /compact or /clear. After one, start fresh if you do not need the old history. budget-router warns you when this is about to happen.'))
    if a['opus_simple'] and pct(a['opus_simple_cost'], a['opus_cost'] or 1) >= 8:
        out.append((f"{a['opus_simple']} short, quick, error-free turns ran on Opus ({pct(a['opus_simple_cost'], a['opus_cost']):.0f}% of Opus spend)",
                    f"Those {a['opus_simple']} turns cost {usd(a['opus_simple_cost'])}. A cheaper tier would have cost roughly half or less; whether it would have answered as well is not measured here.",
                    'Leave the model choice to budget-router (simple prompts go to Sonnet or Haiku), or set /model to Sonnet for routine work.'))
    if a['bad_turns'] and a['bad_share'] >= 8:
        out.append((f"Turns with 3+ failed tool calls took {a['bad_share']:.0f}% of main-chat spend",
                    f"{a['bad_turns']} turns had three or more failed tool calls. Each retry re-reads the whole conversation.",
                    'Stop retrying after the second failure: /rewind to before it went wrong and re-ask with the exact error.'))
    sub = pct(a['side'], t)
    if sub < 5 and a['long_share_total'] >= 25:
        out.append(('Subagents are barely used, and long turns are expensive',
                    f"Subagents are {sub:.0f}% of spend while turns of 30+ requests are {a['long_share_total']:.0f}% of all spend.",
                    'Wide searches and log reads are the best candidates for a subagent (scout, log-triage): the reading stays out of your main context.'))
    r = a['rank']
    if ('opus', 'medium') in r and ('opus', 'xhigh') in r and r[('opus', 'xhigh')]['n'] >= 20 and r[('opus', 'medium')]['n'] >= 20:
        ratio = r[('opus', 'xhigh')]['out'] / max(1.0, r[('opus', 'medium')]['out'])
        if ratio >= 1.5:
            out.append((f"Opus at xhigh writes {ratio:.1f}x the output of Opus at medium per request",
                        f"{r[('opus', 'xhigh')]['out']:.0f} against {r[('opus', 'medium')]['out']:.0f} output tokens on average (harder tasks are also given higher effort, so this is not a controlled comparison).",
                        'Keep xhigh for the prompts that need it ("ultrathink" in one prompt) and /effort lower for routine work.'))
    if store and store.get('seen', 0) < 150:
        out.append((f"The learner has seen {store.get('seen', 0)} turns: too few to trust its savings figure yet",
                    f"Its running saving is {store.get('saved', 0):+.2f} USD against always taking the rule choice. A cheaper step needs 8 recorded turns before it is tried on evidence.",
                    'Leave it on `live` or `shadow` and re-run this report in a few weeks.'))
    if not out:
        out.append(('Nothing stands out', 'No habit crosses a threshold in this period.', 'Re-run after more usage.'))
    return out


CSS = """
:root{--bg:#fff;--fg:#1c2330;--mut:#5b6575;--line:#e3e7ee;--card:#f6f8fb;--ac:#2f6fed;--ok:#1d8a5b;--warn:#b7791f}
@media (prefers-color-scheme:dark){:root{--bg:#10151d;--fg:#e6eaf1;--mut:#9aa6b8;--line:#263041;--card:#171e29;--ac:#6ea0ff;--ok:#4cc38a;--warn:#e0b050}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,sans-serif}
main{max-width:920px;margin:0 auto;padding:24px 16px 64px}
h1{margin:.2em 0}h2{margin:2em 0 .4em;border-bottom:1px solid var(--line);padding-bottom:.2em}
.sub{color:var(--mut)}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}
.card b{display:block;font-size:1.5em}.card span{color:var(--mut);font-size:.9em}
.bar{display:flex;height:22px;border-radius:6px;overflow:hidden;border:1px solid var(--line)}
.bar i{display:block}.leg{display:flex;flex-wrap:wrap;gap:4px 16px;color:var(--mut);font-size:.9em;margin:.4em 0}
table{border-collapse:collapse;width:100%;font-size:.95em}th,td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:right}
th:first-child,td:first-child{text-align:left}.c{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--ac);border-radius:8px;padding:10px 14px;margin:10px 0}
.c h3{margin:.1em 0 .3em;font-size:1.05em}.c p{margin:.25em 0}.do{color:var(--ok)}.muted{color:var(--mut);font-size:.9em}
.day{display:flex;align-items:center;gap:8px;font-size:.85em;color:var(--mut)}.day i{display:block;height:10px;background:var(--ac);border-radius:3px}
"""


def render(a, store, days):
    e = html.escape
    t = a['total'] or 1
    parts = [('Cache reads', 'c_cr', '#2f6fed'), ('Cache writes', 'c_cc', '#7c5cff'), ('Output', 'c_out', '#1d8a5b'), ('Fresh input', 'c_inp', '#b7791f')]
    bar = ''.join(f'<i style="width:{pct(a["parts"][k], t):.1f}%;background:{c}" title="{n}"></i>' for n, k, c in parts)
    leg = ''.join(f'<span><b style="color:{c}">■</b> {n} {pct(a["parts"][k], t):.0f}% ({usd(a["parts"][k])})</span>' for n, k, c in parts)
    when = f'last {days} days' if days else 'all transcripts found'
    h = [f'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Token usage report</title><style>{CSS}</style></head><body><main>']
    h.append(f'<h1>Your Claude Code usage</h1><p class="sub">{when}. Estimates at list prices, not an invoice. Generated locally by budget-router study/report.py; nothing left this machine and no prompt text is in it.</p>')
    h.append('<div class="cards">' + ''.join(f'<div class="card"><b>{v}</b><span>{k}</span></div>' for k, v in [
        ('estimated usage', usd(a['total'])), ('model requests', f"{a['n_req']:,}"), ('your prompts', f"{a['n_turns']:,}"),
        ('median context per request', f"{a['ctx_median'] / 1000:.0f}k tokens"), ('spent on subagents', f"{pct(a['side'], t):.0f}%")]) + '</div>')
    h.append('<h2>What to change</h2>' + ''.join(f'<div class="c"><h3>{e(title)}</h3><p>{e(ev)}</p><p class="do">→ {e(do)}</p></div>' for title, ev, do in conclusions(a, store)))
    h.append(f'<h2>Where the usage goes</h2><div class="bar">{bar}</div><div class="leg">{leg}</div>')
    h.append('<p class="muted">Each request re-sends the whole conversation. Cache reads are that re-sending at the cached price; cache writes are context written for the first time, or re-written after the cache expired.</p>')
    h.append('<h2>By model</h2><table><tr><th>Model</th><th>Requests</th><th>Estimated usage</th><th>Share</th></tr>' + ''.join(
        f'<tr><td>{e(m)}</td><td>{n:,}</td><td>{usd(c)}</td><td>{pct(c, t):.0f}%</td></tr>' for m, (n, c) in sorted(a['by_model'].items(), key=lambda x: -x[1][1])) + '</table>')
    if a['by_day']:
        mx = max(a['by_day'].values()) or 1
        h.append('<h2>By day</h2>' + ''.join(f'<div class="day"><span style="width:84px">{d}</span><i style="width:{max(1, 100 * v / mx):.0f}%;max-width:70%"></i>{usd(v)}</div>' for d, v in list(a['by_day'].items())[-30:]))
    h.append('<h2>Measured cost of each effort level</h2><p class="muted">From your own requests. Output tokens per request are the clean measure (they do not depend on how big the conversation was). Not a controlled test: harder tasks tend to be given higher effort. The last column is the learner\'s built-in guess, replaced by measured costs once a pair has 3+ turns.</p>')
    rows = []
    for fam in ('haiku', 'sonnet', 'opus'):
        base = a['rank'].get((fam, 'medium'))
        for eff in EFFORTS:
            r = a['rank'].get((fam, eff))
            if not r:
                continue
            ratio = f"{r['out'] / max(1.0, base['out']):.2f}x" if base and base['n'] >= 20 and r['n'] >= 20 else '–'
            flag = '' if r['n'] >= 20 else ' <span class="muted">(few)</span>'
            rows.append(f"<tr><td>{fam}·{eff}{flag}</td><td>{r['n']:,}</td><td>{r['out']:.0f}</td><td>{r['think']:.0f}</td><td>{usd(r['cost'])}</td><td>{ratio}</td><td>{ASSUMED_EFFORT_OUT[eff]:.1f}x</td></tr>")
    h.append('<table><tr><th>Model·effort</th><th>Requests</th><th>Avg output tokens</th><th>Avg thinking tokens</th><th>Avg $/request</th><th>Output vs medium (measured)</th><th>Assumed</th></tr>' + ''.join(rows) + '</table>')
    if store:
        g = store.get('cells', {}).get('g', {})
        h.append(f"<h2>What the learner has found</h2><p>{store.get('seen', 0)} turns seen, running saving {store.get('saved', 0):+.2f} USD against always taking the rule choice.</p>")
        trs = []
        for arm, c in sorted(g.items(), key=lambda x: x[1]['c'] / max(1e-9, x[1]['n'])):
            n = c['n']
            trs.append(f"<tr><td>{e(arm)}</td><td>{n:.1f}</td><td>{pct(c['s'], c['s'] + c['f']):.0f}%</td><td>{usd(c['c'] / max(1e-9, n))}</td><td>{'enough to act on' if n >= 8 else 'not enough yet'}</td></tr>")
        h.append('<table><tr><th>Model·effort</th><th>Turns (decayed)</th><th>Went well</th><th>$ per turn</th><th>Evidence</th></tr>' + ''.join(trs) + '</table>')
    h.append('<h2>How to read this</h2><p class="muted">Costs use list prices cached in the script, with cache writes assumed at 1.25x input, so absolute figures are rough; shares are more reliable than totals. A turn counts as having gone well when it had few failed tool calls and you did not redo or rephrase it, which is a weak signal. The habits behind each suggestion, with their sources, are in plugins/budget-router/CHEATSHEET.md.</p>')
    h.append('</main></body></html>')
    return '\n'.join(h)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--days', type=int, default=30, help='how many days back (0 = everything found)')
    ap.add_argument('--projects', default=os.path.expanduser('~/.claude/projects'))
    ap.add_argument('--store', default=None, help='the budget-router store file (default: the newest in ~/.claude/plugins/store)')
    ap.add_argument('--out', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out', 'report.html'))
    args = ap.parse_args()
    since = datetime.now(timezone.utc) - timedelta(days=args.days) if args.days else None
    reqs, turns = load(args.projects, since)
    if not reqs:
        sys.exit('no priced requests found under ' + args.projects)
    a = analyse(reqs, turns)
    store = load_store(args.store)
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    open(args.out, 'w', encoding='utf8').write(render(a, store, args.days))
    print(f"{a['n_req']:,} requests, {a['n_turns']:,} prompts, about {usd(a['total'])} at list prices -> {args.out}")
    for title, ev, do in conclusions(a, store):
        print(f"\n* {title}\n  {ev}\n  -> {do}")


if __name__ == '__main__':
    main()
