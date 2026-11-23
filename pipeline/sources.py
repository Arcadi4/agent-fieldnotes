"""Read-only importers for local agent history. Output may contain private text."""
import json
import re
import sqlite3
from bisect import bisect_right
from collections import defaultdict
from datetime import datetime, timezone

from codex_log_lines import rollout_lines
from prompt_origin import human_prompt


def timestamp(value):
    if value is None:
        return None
    try:
        if str(value).isdigit():
            value = int(value)
            return datetime.fromtimestamp(value / 1000 if value > 10**11 else value, timezone.utc)
        result = datetime.fromisoformat(value)
        return result.astimezone(timezone.utc) if result.tzinfo else None
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def records(lines):
    for line in lines:
        try:
            row = json.loads(line)
        except (ValueError, UnicodeError):
            continue
        if isinstance(row, dict):
            yield row


def text(content):
    if isinstance(content, str):
        return content
    return '\n'.join(str(x.get('text') or '') for x in content or []
                     if isinstance(x, dict) and x.get('type') in {'text', 'input_text'})


def cleaned_input(app, value):
    for tag in ('system-reminder', 'environment_context', 'external_codex_apps_open_page'):
        value = re.sub(r'<'+tag+r'\b[^>]*>.*?</'+tag+r'>', '', value, flags=re.S)
    value = re.sub(r'^\s*<user_query>\s*(.*?)\s*</user_query>\s*$',r'\1',value,flags=re.S)
    if re.match(r'^\s*<(?:teammate-message|task-notification|agent-message|inter-agent-message)(?:\s|>)', value):
        return ''
    return human_prompt(app, value)[0]


def event(app, kind, sid, uid, stamp, **data):
    if stamp and uid and sid:
        return dict(app=app, kind=kind, conversation=sid, id=f'{app}:{uid}', time=stamp.isoformat(), **data)
    return None


def codex(root):
    """Projected user items plus explicit response IDs from root rollouts."""
    db_path = root / 'thread_history_1.sqlite'
    metadata_path = root / 'state_5.sqlite'
    if not db_path.exists() or not metadata_path.exists():
        return
    with sqlite3.connect(metadata_path.as_uri()+'?mode=ro', uri=True) as metadata:
        columns = {row[1] for row in metadata.execute('pragma table_info(threads)')}
        origin = 'originator' if 'originator' in columns else 'NULL'
        roots = {s for s, src, cli in metadata.execute(f'select id,source,{origin} from threads')
                 if src != 'exec' and 'subagent' not in src and cli != 'codex_exec'}
    prompts = defaultdict(list)
    boundaries = {}
    with sqlite3.connect(db_path.as_uri()+'?mode=ro', uri=True) as db:
        sql = "select thread_id,turn_id,item_id,created_at_ms,item_json from thread_items where item_type='userMessage'"
        for sid, turn, uid, t, raw in db.execute(sql):
            if sid not in roots:
                continue
            stamp = timestamp(t)
            body = cleaned_input('codex', text(json.loads(raw).get('content')))
            row = event('codex','prompt',sid,uid,stamp,text=body) if body else None
            boundaries[sid,turn,uid] = row['id'] if row else None
            if stamp:
                prompts[sid,turn].append((stamp, row['id'] if row else None))
            if row:
                yield row
    for group in prompts.values():
        group.sort(key=lambda pair: pair[0])
    for folder in ('sessions', 'archived_sessions'):
        for path in sorted((root/folder).rglob('*.jsonl*')):
            if not (path.name.endswith('.jsonl') or path.name.endswith('.jsonl.zst')):
                continue
            if path.suffix == '.zst' and path.with_suffix('').exists():
                continue
            with rollout_lines(path) as lines:
                yield from codex_rollout(lines, roots, prompts, boundaries)


def codex_rollout(lines, roots, prompts, boundaries):
    sid = None
    active = {}
    starts = {}
    for line in lines:
        if not any(key in line[:400] for key in (b'"session_meta"', b'"UserMessage"', b'"task_started"',
                                                 b'"task_complete"', b'"token_usage_record"')):
            continue
        for row in records([line]):
            p = row.get('payload') or {}
            kind = row.get('type')
            if kind == 'session_meta' and sid is None:
                sid = p.get('id') or p.get('session_id')
                if sid not in roots:
                    return
                continue
            if not sid:
                continue
            turn = p.get('turn_id')
            stamp = timestamp(row.get('timestamp'))
            item = p.get('item') or {}
            if p.get('type') == 'item_completed' and item.get('type') == 'UserMessage' and p.get('thread_id') == sid:
                active[turn] = boundaries.get((sid, turn, item.get('id')))
            elif p.get('type') == 'task_started':
                if turn and stamp:
                    starts.setdefault(turn,stamp)
            elif p.get('type') == 'task_complete':
                active[turn] = None
                start = starts.pop(turn,None)
                if start:
                    yield event('codex','turn',sid,turn,start,end=stamp.isoformat() if stamp and not p.get('error') else None)
            elif kind == 'token_usage_record' and p.get('thread_id') == sid and stamp and p.get('response_id'):
                # Use the projected timestamp only when the rollout lacks a native boundary.
                available = prompts.get((sid, turn), [])
                i = bisect_right([t for t,_ in available], stamp)
                trigger = active.get(turn, available[i-1][1] if i and len(available)==1 else None)
                usage = p.get('usage') or {}
                yield event('codex','response',sid,p['response_id'],stamp,trigger=trigger,
                            input_tokens=usage.get('input_tokens'),cache_read=usage.get('cached_input_tokens'),
                            output_tokens=usage.get('output_tokens'))

    for turn,stamp in starts.items():
        yield event('codex','turn',sid,turn,stamp)


def claude(root):
    """Root Claude conversations, following parent UUIDs through tool results."""
    for path in sorted(root.glob('*/*.jsonl')):
        sid = path.stem
        anchors = {}
        starts = {}
        completions = {}
        tools = {}
        with path.open('rb') as stream:
            for row in records(stream):
                if row.get('isSidechain') or row.get('sessionId',sid) != sid:
                    continue
                uid = row.get('uuid')
                stamp = timestamp(row.get('timestamp'))
                if not uid or not stamp:
                    continue
                anchor = anchors.get(row.get('parentUuid') or row.get('logicalParentUuid'))
                msg = row.get('message') or {}
                body = msg.get('content')
                blocks = [x for x in body if isinstance(x,dict)] if isinstance(body,list) else []
                results = [item for item in blocks if item.get('type')=='tool_result']
                for item in results:
                    tool_id = item.get('tool_use_id')
                    label = tools.get(tool_id)
                    if label and tool_id:
                        yield event('claude','tool',sid,tool_id,stamp,measure=label,failed=item.get('is_error') is True)
                if row.get('type') == 'user' and not results:
                    value = cleaned_input('claude',text(body))
                    generated = (row.get('isMeta') or row.get('promptSource')=='system'
                                 or (row.get('origin') or {}).get('kind') in {'task-notification','teammate-message','agent-message'})
                    if value and not generated:
                        prompt = event('claude','prompt',sid,uid,stamp,text=value)
                        anchor = prompt['id']
                        starts[anchor] = stamp
                        yield prompt
                anchors[uid] = anchor
                if row.get('type') != 'assistant' or row.get('isApiErrorMessage') or msg.get('model') in {'<synthetic>','synthetic'}:
                    continue
                usage = msg.get('usage') or {}
                for item in blocks:
                    if item.get('type')=='tool_use' and item.get('id'):
                        name = item.get('name') or ''
                        if name=='Bash' or name.startswith('mcp__'):
                            tools[item['id']] = 'shell result' if name=='Bash' else 'connected tool result'
                if msg.get('id') and usage:
                    if anchor and msg.get('stop_reason')=='end_turn':
                        completions[anchor] = max(stamp,completions.get(anchor,stamp))
                    raw_input = usage.get('input_tokens')
                    cache_read = usage.get('cache_read_input_tokens') or 0
                    written = usage.get('cache_creation_input_tokens') or 0
                    yield event('claude','response',sid,msg['id'],stamp,trigger=anchor,
                                input_tokens=raw_input+cache_read+written if isinstance(raw_input,int) else None,
                                cache_read=cache_read,output_tokens=usage.get('output_tokens'))

        for anchor,end in completions.items():
            if anchor in starts:
                yield event('claude','turn',sid,anchor,starts[anchor],end=end.isoformat())


def cursor(path):
    """Cursor's retained human composer bubbles. Token counters are unavailable here."""
    with sqlite3.connect(path.as_uri()+'?mode=ro', uri=True) as db:
        ignored = set()
        for key, raw in db.execute("select key,value from cursorDiskKV where key>='composerData:' and key<'composerData;'"):
            try:
                row = json.loads(raw)
            except ValueError:
                continue
            if row.get('isDraft') or row.get('subagentInfo'):
                ignored.add(row.get('composerId') or key.split(':')[1])
            for field in ('subComposerIds','subagentComposerIds'):
                ignored.update(x for x in row.get(field,[]) if isinstance(x,str))
        if db.execute("select 1 from sqlite_master where name='composerHeaders'").fetchone():
            columns={col[1] for col in db.execute('pragma table_info(composerHeaders)')}
            if {'composerId','isSubagent'} <= columns:
                ignored.update(sid for sid, in db.execute('select composerId from composerHeaders where isSubagent=1'))
        query = """select key,value from cursorDiskKV where key>='bubbleId:' and key<'bubbleId;'
                   and json_valid(value) and json_extract(value,'$.type')=1"""
        for key, raw in db.execute(query):
            sid = key.split(':')[1]
            if sid in ignored:
                continue
            row = json.loads(raw)
            body = cleaned_input('cursor',row.get('text') or '')
            result = event('cursor','prompt',sid,key,timestamp(row.get('createdAt')),text=body) if body else None
            if result:
                yield result
