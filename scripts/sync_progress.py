#!/usr/bin/env python3
"""Validate Job Hunter delivery ledger and generate a read-only Markdown board.
No external services or dependencies. Does NOT certify that CI/logs are authentic.
"""
import argparse, hashlib, json, re, sys
from pathlib import Path
from datetime import datetime
ROOT=Path(__file__).resolve().parent.parent
DOCS=ROOT/'docs'
LEDGER=DOCS/'PROGRESS_LEDGER.json'
PRD=DOCS/'PRD.md'
BOARD=DOCS/'PROGRESS.md'
ICONS={'PLANNED':'⬜','REPORTED_UNVERIFIED':'🔵','IN_PROGRESS':'🟡','BLOCKED':'🔴','QA_REVIEW':'🟠','VERIFIED':'✅'}

def get_data():
    return json.loads(LEDGER.read_text(encoding='utf-8'))

def state(phase,allph,cache=None):
    cache={} if cache is None else cache
    pid=phase['id']
    if pid in cache: return cache[pid]
    if phase.get('blocker'):
        cache[pid]='BLOCKED'; return 'BLOCKED'
    tasks=phase.get('tasks',[])
    dependencies_ok=all(state(allph[d],allph,cache)=='VERIFIED' for d in phase.get('depends_on',[]))
    approved=all(phase.get('qa_signoff',{}).get(k) for k in ('reviewer','approved_at','evidence'))
    if tasks and all(t['status']=='VERIFIED' for t in tasks) and dependencies_ok and approved:
        s='VERIFIED'
    elif any(t['status']=='BLOCKED' for t in tasks): s='BLOCKED'
    elif any(t['status']=='QA_REVIEW' for t in tasks): s='QA_REVIEW'
    elif any(t['status']=='IN_PROGRESS' for t in tasks): s='IN_PROGRESS'
    elif any(t['status']=='VERIFIED' for t in tasks): s='IN_PROGRESS'
    elif any(t['status']=='REPORTED_UNVERIFIED' for t in tasks): s='REPORTED_UNVERIFIED'
    else: s='PLANNED'
    cache[pid]=s
    return s

def validate(d):
    errors=[]
    if not PRD.exists(): errors.append('Missing docs/PRD.md')
    elif hashlib.sha256(PRD.read_bytes()).hexdigest()!=d.get('prd_sha256'):
        errors.append('PRD SHA256 differs from locked baseline: require approved ADR and deliberate PRD version/hash update.')
    phases=d.get('phases',[]); ids=[p.get('id') for p in phases]
    if len(ids)!=len(set(ids)):errors.append('Duplicate phase ids')
    index={p['id']:p for p in phases}
    observed=set()
    for p in phases:
        for dep in p.get('depends_on',[]):
            if dep not in index:errors.append(f'{p["id"]}: missing dependency {dep}')
            if dep not in observed:errors.append(f'{p["id"]}: dependency {dep} not earlier in ledger (possible cycle)')
        observed.add(p['id'])
        task_ids=[x['id'] for x in p['tasks']]
        if len(set(task_ids))!=len(task_ids):errors.append(f'{p["id"]}: duplicate task ids')
        for task in p['tasks']:
            tid=task['id']; status=task.get('status'); ev=task.get('evidence',{})
            if status not in ICONS: errors.append(f'{tid}: invalid status {status}')
            if status in ('QA_REVIEW','VERIFIED'):
                required=['commit_sha','test_command','test_result','test_log_or_ci']
                for field in required:
                    if not ev.get(field):errors.append(f'{tid}: {status} requires evidence.{field}')
                if ev.get('commit_sha') and not re.fullmatch(r'[0-9a-fA-F]{7,40}',ev['commit_sha']):
                    errors.append(f'{tid}: commit_sha must be actual 7–40 hex characters')
                if ev.get('test_result') and ev['test_result']!='PASS':
                    errors.append(f'{tid}: {status} must cite a PASS result (real logs independently verified)')
            if status=='VERIFIED':
                for field in ('qa_reviewer','qa_signoff_at'):
                    if not ev.get(field):errors.append(f'{tid}: VERIFIED requires independent {field}')
        if p.get('qa_signoff',{}).get('approved_at') and not p.get('qa_signoff',{}).get('reviewer'):
            errors.append(f'{p["id"]}: signoff time without reviewer')
    return errors

def make_board(d):
    phases=d['phases']; index={p['id']:p for p in phases}; cache={}
    total=sum(len(p['tasks']) for p in phases)
    passed=sum(t['status']=='VERIFIED' for p in phases for t in p['tasks'])
    green=sum(state(p,index,cache)=='VERIFIED' for p in phases)
    out=[
        '# Job Hunter — Live Delivery Dashboard',
        '',
        '**Canonical PRD:** [`PRD.md`](PRD.md) (locked requirements baseline)  ',
        '**Source of truth:** [`PROGRESS_LEDGER.json`](PROGRESS_LEDGER.json) (edit here, NOT in this dashboard)  ',
        '**Agent contract:** [`AGENT_PROTOCOL.md`](AGENT_PROTOCOL.md)  ',
        f'**Status:** {passed}/{total} tasks independently verified; {green}/{len(phases)} phases green.  ',
        f'**Evidence cut-off:** {d.get("baseline","unknown")}',
        '',
        '> 🚦 **Never turn a row green from an agent assertion.** Green is computed only from recorded commit-specific passing tests, independent QA approval, cleared blockers and completed dependencies. This checker validates evidence fields but **cannot establish that the cited tests/logs are genuine**.',
        '',
        '## Legend', '',
        '- ⬜ PLANNED · 🔵 REPORTED_UNVERIFIED · 🟡 IN_PROGRESS · 🟠 QA_REVIEW · 🔴 BLOCKED · ✅ VERIFIED (green)',
        '',
        '## Phase overview', '',
        '| Phase | Workstream | Status | Tasks verified | Dependencies |',
        '|---|---|---|---:|---|'
    ]
    for p in phases:
        s=state(p,index,cache)
        n=sum(t['status']=='VERIFIED' for t in p['tasks'])
        out.append(f'| {p["id"]} | {p["name"]} | {ICONS[s]} {s} | {n}/{len(p["tasks"])} | {", ".join(p["depends_on"]) or "—"} |')
    out += ['', '## Next task', '']
    candidate=next_task(d)
    if candidate:
        out+= [f'**{candidate["id"]}: {candidate["name"]}** (phase {candidate["phase"]}).', '']
    else:out+=['None currently dependency-unblocked. Resolve recorded blockers or audit status.', '']
    out+=['## Historical foundations (NOT independently confirmed today)','',
           '| Component | Earlier report | Current audit |','|---|---|---|']
    for v in d.get('foundation_snapshots',[]):
        out.append(f'| {v["component"]} | {v["reported"]} | {"✅ VERIFIED" if v["verified_now"] else "🔵 UNVERIFIED"} |')
    out+=['','## Phase task checklist','']
    for p in phases:
        s=state(p,index,cache)
        out+= [f'### {p["id"]} — {p["name"]} [{ICONS[s]} {s}]','',
               f'**PRD references:** {", ".join(p["prd_refs"])}  ',
               f'**Exit criterion:** {p["exit_criterion"]}  ',
               f'**Depends on:** {", ".join(p["depends_on"]) or "None"}  ']
        if p.get('blocker'):out+=[f'**Blocker:** {p["blocker"]}  ']
        out+=['']
        for t in p['tasks']:
            mark='x' if t['status']=='VERIFIED' else ' '
            out.append(f'- [{mark}] {ICONS[t["status"]]} **{t["id"]}** — {t["name"]} — `{t["status"]}`')
            ev=t.get('evidence',{})
            if t['status'] in ('QA_REVIEW','VERIFIED'):
                out.append(f'  - Proof: `{ev["commit_sha"]}` · `{ev["test_command"]}` → `{ev["test_result"]}` · {ev["test_log_or_ci"]} · QA: {ev.get("qa_reviewer") or "PENDING"}')
        out+=['']
    out+= ['## Update protocol', '',
            '1. Read `PRD.md` and `AGENT_PROTOCOL.md`. Verify actual branch, HEAD, tests and baseline.',
            '2. Run `python scripts/sync_progress.py --next` and take only a feasible task.',
            '3. Edit **only** task status/evidence in `PROGRESS_LEDGER.json`; never hand-edit this board.',
            '4. Run `python scripts/sync_progress.py --write` to regenerate the board.',
            '5. QA checks the tests and artifacts, then independently marks a task `VERIFIED`.',
            '6. Phase green is computed after every task is verified, dependencies complete, blocker removed and phase QA sign-off saved.',
            '7. Run `python scripts/sync_progress.py --check` in CI and after each status change.',
            '',
            '## Scope changes and drift', '',
            'Never silently delete a PRD requirement. Log changes and approvals in [`DECISIONS.md`](DECISIONS.md), version the PRD, then deliberately update its SHA-256 in the ledger.',
            '']
    return '\n'.join(out)

def next_task(d):
    index={p['id']:p for p in d['phases']}; cache={}
    for p in d['phases']:
        if not all(state(index[x],index,cache)=='VERIFIED' for x in p.get('depends_on',[])):
            continue
        for t in p['tasks']:
            if t['status'] in ('IN_PROGRESS','PLANNED','REPORTED_UNVERIFIED','BLOCKED'):
                return dict(phase=p['id'],id=t['id'],name=t['name'],status=t['status'])
    return None

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    group=parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--write',action='store_true',help='regenerate docs/PROGRESS.md')
    group.add_argument('--check',action='store_true',help='validate ledger, PRD hash and generated dashboard')
    group.add_argument('--next',action='store_true',help='print next dependency-unblocked task')
    args=parser.parse_args();data=get_data();errors=validate(data)
    if errors:
        print('FAILED progress validation:')
        for e in errors: print(' -',e)
        return 1
    if args.next:
        t=next_task(data)
        print(f'{t["id"]}: {t["name"]} [{t["status"]}]' if t else 'No task currently unblocked')
    elif args.write:
        BOARD.write_text(make_board(data),encoding='utf-8')
        print(f'Wrote {BOARD}')
    elif args.check:
        if not BOARD.exists() or BOARD.read_text(encoding='utf-8')!=make_board(data):
            print('FAILED: dashboard stale or missing. Run python scripts/sync_progress.py --write')
            return 1
        print('OK: locked PRD checksum, ledger schema/evidence fields and generated board in sync.')
    return 0
if __name__=='__main__':sys.exit(main())
