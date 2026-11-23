"""Trace Codex CLI reviews to Claude launch calls without exporting transcript text."""
from bisect import bisect_left, bisect_right
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
import argparse
import hashlib
import os
import json
from pathlib import Path
import re
import shlex
import sqlite3

from codex_log_lines import rollout_lines
from prompt_origin import human_prompt
from sources import records

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--input',type=Path,required=True)
parser.add_argument('--out',type=Path,required=True)
parser.add_argument('--codex',type=Path,required=True)
parser.add_argument('--claude',type=Path,required=True)
parser.add_argument('--read-launch-logs',action='store_true')
parser.add_argument('--match-launch-time',action='store_true')
options = parser.parse_args()
index = defaultdict(list)
prompts = {}
latest = None
with options.input.open('rb') as stream:
    for row in records(stream):
        if row['kind']!='prompt' or row['app']!='claude':
            continue
        stamp = datetime.fromisoformat(row['time'])
        key = hashlib.sha256(('claude'+row['conversation']).encode()).hexdigest()[:16]
        index[key].append({'timestamp':row['time']})
        prompts[key,stamp.timestamp()] = row['id']
        latest = stamp if latest is None else max(latest,stamp)
if latest is None:
    raise SystemExit('No Claude human prompts in normalized input')
cutoff = (latest.replace(hour=0,minute=0,second=0,microsecond=0)+timedelta(days=1)).timestamp()
cli = options.codex.resolve() / 'state_5.sqlite'
conn = sqlite3.connect(cli.as_uri() + '?mode=ro', uri=True)
workers = {
    sid:(created / 1000, Path(path), cwd)
    for sid,created,path,cwd in conn.execute("""
      select id,coalesce(created_at_ms,created_at*1000),rollout_path,cwd
      from threads where source='exec' or originator='codex_exec'
    """)
}
worker_roots = {sid for sid, in conn.execute("select id from threads where source='exec'")}
history = options.codex.resolve() / 'thread_history_1.sqlite'
turn_db = sqlite3.connect(history.as_uri() + '?mode=ro', uri=True)
turn_db.execute('attach database ? as states', (cli.as_uri() + '?mode=ro',))
review_children = defaultdict(set)
for parent, child in turn_db.execute("""
    select distinct p.thread_id,c.thread_id
      from thread_turns c join states.threads s on s.id=c.thread_id
      join thread_turns p on p.turn_id=c.root_turn_id and p.thread_id<>c.thread_id
      join states.threads root on p.thread_id=root.id
     where s.source like '%subagent%review%' and s.originator='codex_exec'
       and root.source='exec'
"""):
    if child in workers:
        review_children[parent].add(child)
audit = Counter()
launch = re.compile(r'(?<![\w-])(?:[\w./-]*/)?codex\s+(?:exec|review)\b')
session_identifier = re.compile(
    r'(?:session id:\s*|["\']thread_id["\']\s*:\s*["\'])([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})',
    re.I,
)
generated_prefix = re.compile(r'^\s*<(?:teammate-message|task-notification|agent-message|inter-agent-message)(?:\s|>)')

def epoch(value):
    try:
        if str(value).isdigit():
            return int(value)/1000
        t = datetime.fromisoformat(value)
        return t.replace(tzinfo=timezone.utc).timestamp() if t.tzinfo is None else t.timestamp()
    except (TypeError, ValueError):
        return None

def text_content(content):
    if isinstance(content,str):
        return content
    return '\n'.join(item.get('text','') for item in content or []
                     if isinstance(item,dict) and item.get('type') in ('text','input_text'))

def is_generated(row, body):
    origin = row.get('origin') or {}
    return (row.get('isMeta') or row.get('isSidechain') or row.get('promptSource') == 'system'
            or origin.get('kind') in ('task-notification','agent-message','teammate-message')
            or generated_prefix.match(body) or not human_prompt('claude',body)[0])

def literal_variables(prefix):
    """Resolve simple shell assignments without executing the command."""
    values = {}
    pattern = r"""(?:^|[;\n])\s*(?:export\s+)?([A-Za-z_]\w*)=(?:"([^"]*)"|'([^']*)'|([^\s;&|\n]+))"""
    for assignment in re.finditer(pattern,prefix):
        rhs = next(v for v in assignment.groups()[1:] if v is not None)
        if assignment[3] is None:
            rhs = expand_variables(rhs,values)
        if rhs and not any(char in rhs for char in ('$', '`', '*', '\n')):
            values[assignment[1]] = rhs
        else:
            values.pop(assignment[1],None)
    return values

def expand_variables(text, values):
    return re.sub(r'\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))',
                  lambda m: values.get(m[1] or m[2], m[0]), text)

def cwd_at_launch(command, cwd, position, variables):
    """Resolve literal cd and --cd/-C paths in the logged command."""
    prefix = command[:position]
    for match in re.finditer(r'(?:^|[;&|\n])\s*cd\s+([^;&|\n]+)',prefix):
        try:
            args = shlex.split(match[1])
        except ValueError:
            return None
        if len(args)!=1:
            return None
        destination = expand_variables(args[0],variables)
        if any(symbol in destination for symbol in ('$', '`', '*')):
            return None
        cwd = str(Path(cwd,destination).expanduser().resolve())
    try:
        argv=shlex.split(re.split(r'[\n;&|]',command[position:],maxsplit=1)[0])
    except ValueError:
        return None
    argv = [expand_variables(arg,variables) for arg in argv]
    for i, arg in enumerate(argv):
        if arg in ('-C','--cd') and i+1<len(argv):
            cwd = argv[i+1] if argv[i+1].startswith('/') else str(Path(cwd,argv[i+1]))
            break
        if arg.startswith('--cd='):
            cwd = str(Path(cwd,arg[5:]))
            break
    return str(Path(cwd).expanduser().resolve()) if cwd and '$' not in cwd else None

# The lookup key for nested Claude tool calls is the tool-use ID in the child metadata.
calls = defaultdict(set)
reviews = defaultdict(list)
results = defaultdict(list)
child_spawns = {}
automation = {}
launch_artifacts = defaultdict(set)
claude_sessions = options.claude.resolve()

def scan(path, root, child=None):
    anchors = {}
    retained = {epoch(m['timestamp']) for m in index[root]}
    for line in path.open('rb'):
        if b'"uuid"' not in line:
            continue
        try:
            row = json.loads(line)
        except ValueError:
            continue
        uid,t = row.get('uuid'),epoch(row.get('timestamp'))
        if not uid or not t or t >= cutoff:
            continue
        if child is None and row.get('isSidechain'):
            continue
        kind = row.get('type')
        message = row.get('message') or {}
        body = message.get('content')
        items = body if isinstance(body,list) else []
        anchor = child or anchors.get(row.get('parentUuid') or row.get('logicalParentUuid'))
        if kind == 'user':
            tool_results=[x for x in items if isinstance(x,dict) and x.get('type')=='tool_result']
            for item in tool_results:
                ids={match.group(1).lower() for match in session_identifier.finditer(text_content(item.get('content')))} & workers.keys()
                if ids and item.get('tool_use_id'):
                    results[item['tool_use_id']].append((t,ids))
            if child is None and not tool_results:
                generated = is_generated(row,text_content(body))
                if t in retained and generated:
                    automation[root,t] = anchor
                if not generated:
                    anchor = (root,t) if t in retained else None
        anchors[uid] = anchor
        if kind != 'assistant':
            continue
        for item in items:
            if not isinstance(item,dict) or item.get('type')!='tool_use' or not item.get('id'):
                continue
            tool_id = item['id']
            if anchor:
                calls[tool_id].add(anchor)
            command = (item.get('input') or {}).get('command')
            if item.get('name')!='Bash' or not isinstance(command,str):
                continue
            hits = list(launch.finditer(command))
            if not hits:
                continue
            ranges = []
            for match in hits:
                variables = literal_variables(command[:match.start()])
                cwd = cwd_at_launch(command,row.get('cwd') or '',match.start(),variables)
                if cwd:
                    ranges.append(cwd)
                    # Some launches redirect Codex's session header to a retained log.
                    tail = command[match.start():].splitlines()[0]
                    for out in re.finditer(r'''(?:^|[^>])>\s*("[^"]+"|'[^']+'|[^&;\s>|]+)''', tail):
                        raw = expand_variables(out[1].strip("\"'"),variables)
                        if raw and not any(c in raw for c in ('$', '`', '*')):
                            launch_artifacts[tool_id].add(Path(cwd, raw).expanduser())
            reviews[tool_id].append((t,tuple(set(ranges))))

for path in claude_sessions.glob('*/*.jsonl'):
    root=hashlib.sha256(('claude'+path.stem).encode()).hexdigest()[:16]
    if root not in index:
        continue
    scan(path,root)
    child_root=path.with_suffix('')/'subagents'
    for meta_path in child_root.glob('*.meta.json'):
        meta=json.loads(meta_path.read_bytes())
        if not meta.get('toolUseId'):
            continue
        child_path=meta_path.with_name(meta_path.name.removesuffix('.meta.json')+'.jsonl')
        if not child_path.exists():
            continue
        child=(root,child_path.stem)
        child_spawns[child]=meta['toolUseId']
        scan(child_path,root,child)

def resolve(anchor, visited=frozenset()):
    if anchor in visited:
        return set()
    if isinstance(anchor[1],(float,int)):
        return {anchor}
    parents=calls.get(child_spawns.get(anchor),())
    return {prompt for parent in parents for prompt in resolve(parent,visited|{anchor})}

# Accept direct session IDs seen in the launch result. Use a checked cwd/start-time
# match for other jobs when every plausible launch leads to the same human prompt.
explicit=defaultdict(set)
time_windows=defaultdict(list)
for tool_id, events in reviews.items():
    anchors={p for a in calls[tool_id] for p in resolve(a)}
    if len(anchors)!=1:
        continue
    prompt=next(iter(anchors))
    first=min(t for t,_ in events)
    if first<prompt[1]:
        continue
    paths={cwd for _,cwds in events for cwd in cwds}
    for k,ids in results.get(tool_id,[]):
        for sid in ids & worker_roots:
            if first-1<=workers[sid][0]<=k+1:
                explicit[sid].add(prompt)
    for artifact in launch_artifacts.get(tool_id, ()) if options.read_launch_logs else ():
        try:
            if not artifact.is_file() or artifact.stat().st_size > 8_000_000:
                continue
            recorded = artifact.read_text(errors='replace')
        except OSError:
            continue
        for match in session_identifier.finditer(recorded):
            sid = match.group(1).lower()
            if sid in worker_roots and first - 1 <= workers[sid][0] <= first + 30:
                explicit[sid].add(prompt)
    for cwd in paths:
        time_windows[cwd].append((first,prompt))
for windows in time_windows.values():
    windows.sort()
index_starts={cwd:[t for t,_ in windows] for cwd,windows in time_windows.items()}

linked={}
for sid,(started,path,cwd) in workers.items():
    if sid not in worker_roots or started>=cutoff:
        continue
    candidates=explicit.get(sid)
    method='session ID'
    cwd=str(Path(cwd).resolve())
    starts=index_starts.get(cwd,[])
    low=bisect_left(starts,started-8)
    high=bisect_right(starts,started+.5)
    timed={prompt for _,prompt in time_windows[cwd][low:high]}
    if candidates and timed:
        audit['timing cross-check agreed' if candidates==timed else 'timing cross-check disagreed']+=1
    if not candidates and options.match_launch_time:
        candidates=timed
        method='cwd and launch time'
    if len(candidates)==1:
        linked[sid]=(next(iter(candidates)),method)
        audit[method]+=1
    elif candidates:
        audit['ambiguous launch']+=1

child_work = defaultdict(list)
response_claims = defaultdict(set)
response_metadata = {}
for sid,(prompt,method) in linked.items():
    started,_,_ = workers[sid]
    responses = {}
    commands = set()
    end = None
    for owner in [sid,*review_children[sid]]:
        _,path,_ = workers[owner]
        if not path.exists():
            path = path.with_name(path.name + '.zst')
        if not path.exists():
            audit['linked worker missing rollout'] += 1
            continue
        with rollout_lines(path) as lines:
            for line in lines:
                if not any(key in line[:300] for key in (b'"token_usage_record"',b'"item_completed"',b'"task_complete"')):
                    continue
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                t = epoch(row.get('timestamp'))
                if not t or not started <= t < cutoff:
                    continue
                p = row.get('payload') or {}
                if row.get('type')=='token_usage_record' and p.get('thread_id')==owner and p.get('response_id'):
                    usage = p.get('usage') or {}
                    responses.setdefault(p['response_id'], (t,usage))
                elif p.get('type')=='task_complete' and not p.get('error'):
                    end = max(end or t, t)
                elif p.get('type')=='item_completed' and p.get('thread_id')==owner:
                    item = p.get('item') or {}
                    if item.get('type') in ('CommandExecution','McpToolCall') and item.get('id'):
                        commands.add(item['id'])
    if review_children[sid]:
        audit['linked jobs with a native reviewer'] += 1
    if responses:
        audit['linked jobs with response IDs'] += 1
    if end and end > started:
        audit['linked complete jobs'] += 1
    job = {'conversation':sid,'method':method,'start':started,'end':end}
    job_index = len(child_work[prompt])
    child_work[prompt].append(job)
    for response,metadata in responses.items():
        response_claims[response].add((prompt,job_index))
        previous = response_metadata.get(response)
        if not previous or metadata[0] < previous[0]:
            response_metadata[response] = metadata
options.out.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
with open(options.out,'x',opener=lambda p,f:os.open(p,f,0o600)) as stream:
    count = 0
    for response,claims in response_claims.items():
        if len(claims)!=1:
            continue
        prompt,job_index = next(iter(claims))
        if prompt in automation or prompt not in prompts:
            continue
        job = child_work[prompt][job_index]
        stamp,usage = response_metadata[response]
        row = dict(app='codex',kind='response',id='codex:'+response,
                   conversation=job['conversation'],time=datetime.fromtimestamp(stamp,timezone.utc).isoformat(),
                   trigger=prompts[prompt],input_tokens=usage.get('input_tokens'),
                   output_tokens=usage.get('output_tokens'),cache_read=usage.get('cached_input_tokens'))
        stream.write(json.dumps(row,separators=(',',':'))+'\n')
        count += 1
    print(f'Wrote {count} uniquely attributed reviewer responses to private output.')
