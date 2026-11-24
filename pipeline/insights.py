"""Build the eight insight cards used by the dashboard from normalized data."""
from collections import Counter, defaultdict
from datetime import timedelta
from zoneinfo import ZoneInfo


def insight_cards(prompts, labels, conversations, tokens, tool_events, turns, timezone):
    out = []

    def card(ident, title, rows, definition):
        if rows:
            out.append(dict(id=ident,title=title,description=definition,rows=rows,columns=list(rows[0]),
                            source='Local normalized agent history',definitions=[],filters=[],caveats=[]))

    corrections = Counter(labels[p['id']].get('revision') for p in prompts
                          if labels[p['id']].get('interaction')=='correction')
    corrections.pop(None,None)
    corrections.pop('none',None)
    n = sum(corrections.values())
    card('revision-breakdown-clear','What my corrections ask agents to change',
         [{'Revision type':k.replace('_',' ').capitalize(),'Prompt occurrences':v,'Share (%)':100*v/n}
          for k,v in corrections.most_common()], 'Share of classified correction prompts.')

    dissatisfaction = defaultdict(Counter)
    progress = defaultdict(Counter)
    for group in conversations.values():
        if len(group)<2:
            continue
        opening = labels[group[0]['id']].get('autonomy')
        closing = labels[group[-1]['id']].get('autonomy')
        if opening and closing and opening!='unclear':
            progress[opening][closing=='execute'] += 1
        for p in group[1:]:
            answer = labels[p['id']]
            if answer.get('feedback') not in ('uncertain',None):
                key = p['stamp'].strftime('%Y-%m'),answer.get('use_case','unclear')
                dissatisfaction[key]['total'] += 1
                dissatisfaction[key]['negative'] += answer['feedback'] in ('negative','strongly_negative')
    by_month = defaultdict(Counter)
    for (month,_),c in dissatisfaction.items():
        by_month[month].update(c)
    card('dissatisfaction-trend-clear','Follow-up prompts flagged for dissatisfaction',
         [{'Month':m+'-01','Share (%)':100*c['negative']/c['total'],'Flagged prompts':c['negative'],
           'Labeled follow-ups':c['total']} for m,c in sorted(by_month.items())],
         'Negative feedback among labeled follow-up prompts.')
    if len(by_month)>=2:
        a,b = sorted(by_month)[-2:]
        keys = sorted({task for month,task in dissatisfaction if task!='unclear'
                       and (a,task) in dissatisfaction and (b,task) in dissatisfaction})
        if keys:
            first = [dissatisfaction[a,k] for k in keys]
            last = [dissatisfaction[b,k] for k in keys]
            an,bn = sum(c['total'] for c in first),sum(c['total'] for c in last)
            av = 100*sum(c['negative'] for c in first)/an
            bv = 100*sum(c['negative'] for c in last)/bn
            mix = 100*sum(x['total']*y['negative']/y['total'] for x,y in zip(first,last))/an
            card('dissatisfaction-waterfall-clear','How task mix changed the dissatisfaction rate',
                 [{'Step':k,'Rate points':v} for k,v in [(a,av),('Within tasks',mix-av),('Task mix',bv-mix),(b,bv)]],
                 'Decomposition across task categories present in both months. Values are rates or percentage-point changes.')
    card('request-progression-clear','How often conversations end with a request to execute',
         [{'Opening request':k.capitalize(),'Share (%)':100*c[True]/sum(c.values()),'Conversations':sum(c.values())}
          for k,c in sorted(progress.items())], 'The denominator is conversations with classified opening and closing requests.')

    components = defaultdict(Counter)
    for app in tokens.values():
        for month,row in app.items():
            if row.get('token_coverage') and row['token_coverage']==row.get('cache_coverage'):
                components[month].update({k:row[k] for k in ('input_tokens','output_tokens','cache_read')})
    rows = []
    for month,c in sorted(components.items())[-12:]:
        total = c['input_tokens']+c['output_tokens']
        if total:
            rows.append({'Period':month,'Cached input':c['cache_read']/total,
                         'Other input':(c['input_tokens']-c['cache_read'])/total,'Output':c['output_tokens']/total})
    card('token-composition-clear','Cache reads as a share of recorded tokens',rows,
         'Includes logged work with cache-read coverage. Input includes cache reads.')

    tools = defaultdict(Counter)
    for t in tool_events:
        if isinstance(t.get('failed'),bool):
            key = t['stamp'].strftime('%Y-%m'),t['app']+' · '+str(t.get('measure','reported tool result'))
            tools[key].update(total=1, failed=int(t['failed']))
    card('tool-friction-clear','Recorded tool errors by app',
         [{'Month':m+'-01','Measure':kind,'Adverse result (%)':100*c['failed']/c['total'],
           'Recorded tool events':c['total']} for (m,kind),c in sorted(tools.items())],
         'An error is defined by the source recording the tool result.')

    points = defaultdict(list)
    for turn in turns:
        end = turn.get('end_stamp')
        start = turn['stamp']
        if not end or end<=start:
            continue
        month = start.replace(day=1,hour=0,minute=0,second=0,microsecond=0)
        while month<end:
            boundary = (month+timedelta(days=32)).replace(day=1)
            c = turn['app'],turn['conversation']
            points[month.strftime('%Y-%m')].extend([(max(month,start),1,c),(min(boundary,end),-1,c)])
            month = boundary
    overlaps = []
    for month,orders in sorted(points.items()):
        active = Counter()
        overall = shared = 0
        previous = None
        for stamp,direction,c in sorted(orders):
            if previous is not None and active:
                dt = (stamp-previous).total_seconds()
                overall += dt
                if len(active)>=2:
                    shared += dt
            active[c] += direction
            if not active[c]:
                del active[c]
            previous = stamp
        if overall:
            overlaps.append({'Period':month,'Overlap (%)':100*shared/overall,'Observed active hours':overall/3600})
    card('overlap-clear','Time spent in overlapping agent conversations',overlaps,
         'Share of logged active time with two or more distinct conversations running.')

    weekdays = ('Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday')
    intervals = ('12–6 AM', '6 AM–noon', 'Noon–6 PM', '6 PM–midnight')
    clock = Counter()
    for p in prompts:
        local = p['stamp'].astimezone(ZoneInfo(timezone))
        clock[local.weekday(),local.hour//6] += 1
    card('prompt-clock-clear','When I send prompts',
         [{'Day':day,'Interval':interval,'Prompt records':clock[i,block]}
          for i,day in enumerate(weekdays) for block,interval in enumerate(intervals)],
         'Prompt records by weekday and six-hour interval in '+timezone+'.')
    out[-1]['timezone'] = timezone
    return out
