'use strict';
function validTrendMonth(month){return typeof month==='string'&&/^(?:19|20)\d{2}-(?:0[1-9]|1[0-2])$/.test(month);}
const useColors={software_development:'#76b3ff',debugging:'#e893b4',agent_setup:'#c4a1e2',model_training:'#ffbc6d',data_analysis:'#efcf78',research_learning:'#9ac7b0',writing_communication:'#9faee6',creative_design:'#f6a089',infrastructure_operations:'#73c5ce',personal_planning:'#c8c899',task_coordination:'#b6a0cc',other_mixed:'#bd9c8c',unclear:'#758394',uncertain:'#647182'};
const feedbackColors={strongly_negative:'#e68b9a',negative:'#ffa682',mixed:'#ecc97b',positive:'#85b8ed',strongly_positive:'#80c7b0',no_feedback:'#748393',uncertain:'#586777'},steeringColors={none:'#748393',light:'#adc9eb',moderate:'#76b3ff',heavy:'#ffb278',uncertain:'#586777'};
function stackedTime(container,observations,q,labels,palette,allowed,share){observations=observations.filter(r=>validTrendMonth(r.month));const months=[...new Set(observations.map(r=>r.month))].sort(),groups=months.map(m=>{const counts={};for(const r of observations.filter(x=>x.month===m)){const k=effective(r,q);if(allowed(k))counts[k]=(counts[k]||0)+1}return counts});const keys=Object.keys(labels).filter(k=>groups.some(g=>g[k]>0));const w=container.clientWidth||450,h=280,left=44,top=12,bottom=38,pw=w-left-10,ph=h-top-bottom;const totals=groups.map(g=>Object.values(g).reduce((a,b)=>a+b,0));let max=share?100:Math.max(1,...totals)*1.08;const step=pw/Math.max(1,months.length),bar=step*.65;let svg=`<svg role="img" aria-label="Monthly ${q.replaceAll('_',' ')} ${share?'distribution in percent':'conversation counts'}" viewBox="0 0 ${w} ${h}">`;for(let i=0;i<=4;i++){const value=max*i/4,y=top+ph*(1-i/4);svg+=`<line x1="${left}" y1="${y}" x2="${w-10}" y2="${y}" stroke="#2c3949"/><text x="${left-8}" y="${y+4}" text-anchor="end">${share?Math.round(value)+'%':compact(value)}</text>`}months.forEach((m,i)=>{let y=top+ph;for(const key of keys){const count=groups[i][key]||0,value=share?(totals[i]?count/totals[i]*100:0):count,hh=value/max*ph;if(!hh)continue;y-=hh;svg+=`<rect x="${left+i*step+(step-bar)/2}" y="${y}" width="${bar}" height="${hh}" fill="${palette[key]||'#7b8fa3'}"><title>${m}, ${labels[key]}: ${count} of ${totals[i]} conversation-months (${totals[i]?(count/totals[i]*100).toFixed(1):0}%)</title></rect>`}const every=w<500?3:2;if(i%every===0||i===months.length-1){const date=new Date(+m.slice(0,4),+m.slice(5,7)-1,1),label=date.toLocaleDateString('en-US',{month:'short'});svg+=`<text x="${left+step*(i+.5)}" y="${h-16}" text-anchor="middle">${label}</text>`;if(i===0||m.endsWith('-01'))svg+=`<text x="${left+step*(i+.5)}" y="${h-2}" text-anchor="middle">${m.slice(0,4)}</text>`}});svg+='</svg>';container.classList.add('time-chart');container.innerHTML=svg+`<div class="time-legend">${keys.map(k=>`<span><i style="background:${palette[k]||'#7b8fa3'}"></i>${labels[k]}</span>`).join('')}</div>`}
function renderQualTime(){const observations=monthlyQual.filter(r=>validTrendMonth(r.month)&&(selectedApp==='all'||r.app===selectedApp)),showAll=$('include-uninformative').checked,share=$('qual-measure').value==='share';if(!observations.length){for(const id of ['use-cases','feedback-dist','steering-dist'])$(id).textContent='No monthly readings available for this selection.';return}stackedTime($('use-cases'),observations,'use_case',useNames,useColors,k=>showAll||!['unclear','uncertain'].includes(k),share);stackedTime($('feedback-dist'),observations,'feedback',feedbackNames,feedbackColors,k=>showAll||!['no_feedback','uncertain'].includes(k),share);stackedTime($('steering-dist'),observations,'steering',steeringNames,steeringColors,k=>showAll||!['none','uncertain'].includes(k),share);}
const telemetryLabels = {
  total_tokens: 'Reported tokens',
  turns: 'Recorded work cycles',
  turns_per_thread: 'Work cycles per active conversation',
  iterations: 'ReACT iterations',
  iterations_per_thread: 'ReACT iterations per active conversation',
  iterations_per_prompt: 'ReACT iterations per user prompt',
};

function telemetryRows(app, kind) {
  const rows = {};
  const matched = promptReact?.apps[app] || {};
  const archived = metrics.apps[app].monthly;
  const iterations = agentIterations?.apps[app]?.monthly || {};
  const tokens = metrics.token_trends?.[app] || {};
  for (const month of new Set([...Object.keys(tokens), ...Object.keys(iterations), ...Object.keys(matched)])) {
    if (!validTrendMonth(month)) continue;
    const matchedMonth = matched[month];
    const outerTurns = tokens[month]?.turns;
    const values = {
      total_tokens: [tokens[month]?.total_tokens, null],
      turns: [outerTurns, null],
      turns_per_thread: [outerTurns, archived[month]?.threads],
      iterations: [iterations[month]?.iterations, null],
      iterations_per_thread: [iterations[month]?.iterations, iterations[month]?.active_conversations],
      iterations_per_prompt: [matchedMonth?.iterations, matchedMonth?.prompts],
    };
    const [numerator, denominator] = values[kind];
    if (!Number.isFinite(numerator) || (kind.includes('_per_') && !denominator)) continue;
    rows[month] = {numerator, denominator};
  }
  return rows;
}

function telemetrySeries(kind) {
  const byApp = selectedApps().map(app => [app, telemetryRows(app, kind)]);
  const months = [...new Set(byApp.flatMap(([, rows]) => Object.keys(rows)))].sort();
  return months.map(month => {
    const entries = byApp.filter(([, rows]) => rows[month]);
    const numerator = entries.reduce((sum, [, rows]) => sum + rows[month].numerator, 0);
    const denominator = entries.reduce((sum, [, rows]) => sum + (rows[month].denominator || 0), 0);
    const apps = entries.map(([app]) => app);
    return {month, numerator, denominator, apps, value: denominator ? numerator / denominator : numerator};
  });
}

function showTelemetryAvailability() {
  const select = $('token-measure');
  const available = [...select.options].filter(option => {
    const supported = telemetrySeries(option.value).length > 0;
    option.disabled = !supported;
    return supported;
  });
  if (select.selectedOptions[0]?.disabled && available.length) select.value = available[0].value;
  select.disabled = !available.length;
}

function drawTelemetryChart(kind, chartId, legendId) {
  const container = $(chartId);
  const legend = $(legendId);
  const w = container.clientWidth;
  if (w < 110) return;
  const rows = telemetrySeries(kind);
  if (!rows.length) {
    container.classList.add('chart-unavailable');
    container.innerHTML = '<p class="muted">No recorded data for this app.</p>';
    legend.replaceChildren();
    return;
  }
  container.classList.remove('chart-unavailable');
  const h = container.clientHeight || 230;
  const left = 49, right = 13, top = 14, bottom = 38;
  const plotWidth = w - left - right, plotHeight = h - top - bottom;
  const rawMax = Math.max(1, ...rows.map(row => row.value));
  const increment = 10 ** Math.floor(Math.log10(rawMax / 4));
  const tick = Math.ceil(rawMax / (4 * increment)) * increment;
  const maximum = tick * 4;
  const step = plotWidth / rows.length;
  const x = i => left + (i + .5) * step;
  const y = value => top + (1 - value / maximum) * plotHeight;
  const label = telemetryLabels[kind];
  const color = selectedApp === 'all' ? 'var(--accent)' : colors[selectedApp];
  const asLine = kind === 'iterations_per_prompt';
  const numberLabel = value => number(Math.round(value * 100) / 100);
  const denominatorLabel = asLine ? 'matched prompts' : 'active conversations';
  let svg = `<svg role="img" aria-label="Monthly ${label.toLowerCase()}" viewBox="0 0 ${w} ${h}">`;
  for (let i = 0; i <= 4; i++) {
    const value = tick * i;
    svg += `<line x1="${left}" x2="${w - right}" y1="${y(value)}" y2="${y(value)}"/><text x="${left - 7}" y="${y(value) + 4}" text-anchor="end">${compact(value)}</text>`;
  }
  if (asLine) {
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1], next = rows[i];
      const monthIndex = month => Number(month.slice(0,4))*12 + Number(month.slice(5,7));
      if (monthIndex(next.month) - monthIndex(prev.month) !== 1 || next.apps.join() !== prev.apps.join()) continue;
      svg += `<path d="M${x(i - 1)},${y(prev.value)} L${x(i)},${y(next.value)}" stroke="${color}" stroke-width="2" fill="none"/>`;
    }
  }
  const tickEvery = Math.max(1, Math.ceil(58 / step));
  rows.forEach((row, i) => {
    const months = new Date(row.month + '-01T12:00:00Z');
    const date = months.toLocaleDateString('en-US', {month:'short', year:'numeric', timeZone:'UTC'});
    const count = row.denominator ? ` · ${number(row.numerator)} / ${number(row.denominator)} ${denominatorLabel}` : '';
    const source = row.apps.map(app => names[app]).join(' + ');
    const title = `<title>${date} · ${source}: ${numberLabel(row.value)}${count}</title>`;
    const bar = Math.min(62, step * .62);
    svg += asLine
      ? `<circle cx="${x(i)}" cy="${y(row.value)}" r="5" fill="${color}">${title}</circle>`
      : `<rect x="${x(i)-bar/2}" y="${y(row.value)}" width="${bar}" height="${Math.max(1,y(0)-y(row.value))}" rx="2" fill="${color}">${title}</rect>`;
    if (i % tickEvery === 0 && (i === rows.length - 1 || rows.length - 1 - i >= tickEvery) || i === rows.length - 1) {
      svg += `<text x="${x(i)}" y="${h - 14}" text-anchor="middle">${date.replace(' 20', ' ’')}</text>`;
    }
  });
  container.innerHTML = svg + '</svg>';
  const seriesApps = selectedApps().filter(app => rows.some(row => row.apps.includes(app)));
  legend.innerHTML = `<span><i class="swatch" style="background:${color}"></i>${seriesApps.map(app => names[app]).join(' + ')}${seriesApps.length > 1 ? ' · combined' : ''}</span>`;
}

function renderTokenChart() {
  if (!metrics) return;
  showTelemetryAvailability();
  drawTelemetryChart($('token-measure').value, 'token-chart', 'token-legend');
  renderWorkHorizon();
  renderThreadFollowThrough();
}

const horizonMeasures = {
  iterations: {
    bins: ['1–5', '6–19', '20–99', '100+'],
    unit: 'iterations',
    description: 'Model responses from one human prompt, including delegated responses when the logs link them to that prompt.',
  },
  elapsed: {
    bins: ['Under 1 min', '1–<5 min', '5–<30 min', '30+ min'],
    unit: 'minutes',
    description: 'Time from a human prompt to its last observed response or completion, including linked reviews and waiting.',
  },
};

function renderWorkHorizon() {
  const measure = $('horizon-measure').value;
  const weight = $('horizon-weight').value;
  const {bins, unit, description} = horizonMeasures[measure];
  const weighted = weight === 'work';
  const shareOf = weighted ? unit : 'prompts';
  const palette = ['#bcd7f4', '#6fa7e1', '#3874b8', '#9b4271'];
  const data = promptReact?.horizon?.[measure] ?? {};
  const rows = Object.entries(data[selectedApp] ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const chart = $('prompt-react-chart');
  const legend = $('prompt-react-legend');
  const scope = $('horizon-scope');
  const reading = $('horizon-reading');
  $('horizon-description').textContent = description;
  $('horizon-weight').options[1].textContent = `Share of ${measure === 'elapsed' ? 'elapsed minutes' : unit}`;
  chart.classList.toggle('chart-unavailable', !rows.length);
  if (!rows.length) {
    chart.innerHTML = '<p class="muted">No matched records for this app and measure.</p>';
    legend.replaceChildren();
    scope.textContent = '';
    reading.textContent = '';
    return;
  }
  const appsIn = month => selectedApps().filter(app => data[app]?.[month]);
  const appNames = month => appsIn(month).map(app => names[app]).join(' + ');
  const appCounts = month => appsIn(month).map(app => `${names[app]} ${number(data[app][month].n)}`).join(' · ');
  const formats = new Intl.NumberFormat('en-US', {maximumFractionDigits: 1});
  const percent = fraction => `${formats.format(100 * fraction)}%`;
  const monthLabel = month => new Date(month + '-01T12:00:00Z').toLocaleDateString('en-US', {
    month: 'short', year: 'numeric', timeZone: 'UTC',
  }).replace(' 20', ' ’');
  const dayFormat = new Intl.DateTimeFormat('en-US', {month:'short', day:'numeric', timeZone:'UTC'});
  const dateRange = ({first_day, last_day}) => first_day && last_day
    ? dayFormat.formatRange(new Date(first_day + 'T12:00:00Z'), new Date(last_day + 'T12:00:00Z'))
    : '—';
  const shortFirstWindow = rows.length > 1 && rows[0][1].observed_days <= 7;
  scope.textContent = shortFirstWindow
    ? `The first bar covers only ${dateRange(rows[0][1])} (${number(rows[0][1].n)} matched ${appNames(rows[0][0])} prompts).`
    : '';
  const tail = measure === 'elapsed' ? '30+ min' : '100+ iterations';
  reading.textContent = weighted
    ? `Labels above the bars show the share of ${measure === 'elapsed' ? 'elapsed minutes' : 'iterations'} from runs that reached ${tail}.`
    : `Labels above the bars show the share of matched prompts that reached ${tail}.`;
  const w = chart.clientWidth;
  if (w < 110) return;
  const h = chart.clientHeight || 230;
  const left = 44, right = 12, top = 28, bottom = 48;
  const plotHeight = h - top - bottom;
  const step = (w - left - right) / rows.length;
  const bar = Math.min(82, step * .68);
  let svg = `<svg role="img" aria-label="Monthly share of ${shareOf} by ${measure === 'elapsed' ? 'elapsed time' : 'ReACT iterations per prompt'}" viewBox="0 0 ${w} ${h}">`;
  for (let i = 0; i <= 4; i++) {
    const y = top + plotHeight * (1 - i / 4);
    svg += `<line x1="${left}" x2="${w-right}" y1="${y}" y2="${y}"/><text x="${left-7}" y="${y+4}" text-anchor="end">${i * 25}%</text>`;
  }
  rows.forEach(([month, d], i) => {
    const x = left + (i + .5) * step;
    const sizes = weighted ? d.work : d.counts;
    const total = weighted ? d.sum : d.n;
    let y = top + plotHeight;
    sizes.forEach((value, bin) => {
      if (value <= 0 || total <= 0) return;
      const share = value / total;
      const height = share * plotHeight;
      y -= height;
      const label = `${dateRange(d)} · ${appCounts(month)} · ${bins[bin]}${measure === 'iterations' ? ' iterations per prompt' : ''}: ${percent(share)} · ${formats.format(value)} of ${formats.format(total)} ${shareOf}`;
      svg += `<rect x="${x-bar/2}" y="${y}" width="${bar}" height="${height}" fill="${palette[bin]}"><title>${label}</title></rect>`;
    });
    const labelEvery = Math.max(1, Math.ceil(38 / step));
    if (i % labelEvery === 0 || i === rows.length - 1 && step >= 32) {
      const tailShare = total ? percent(sizes.at(-1) / total) : '—';
      svg += `<text class="horizon-tail" x="${x}" y="${top-10}" text-anchor="middle">${tailShare}</text>`;
      const tick = step < 73 ? monthLabel(month).split(' ')[0] : dateRange(d);
      svg += `<text x="${x}" y="${h-26}" text-anchor="middle">${tick}</text>`;
      if (step >= 44) {
        const sample = step < 73 ? `n=${number(d.n)}` : `${number(d.n)} prompts`;
        svg += `<text class="horizon-sample" x="${x}" y="${h-10}" text-anchor="middle">${sample}</text>`;
      }
    }
  });
  chart.innerHTML = svg + '</svg>';
  legend.innerHTML = bins.map((bin, i) =>
    `<span><i class="swatch" style="background:${palette[i]}"></i>${bin}${measure === 'iterations' ? ' iterations' : ''}</span>`
  ).join('');
}

function renderThreadFollowThrough() {
  const chart = $('thread-follow-chart');
  const details = $('thread-follow-monthly');
  const rows = Object.entries(promptReact?.thread_cohorts || {})
    .filter(([month, apps]) => validTrendMonth(month) && apps[selectedApp]?.n > 0)
    .map(([month, apps]) => [month, apps[selectedApp]]);
  details.hidden = !rows.length;
  chart.classList.toggle('chart-unavailable', !rows.length);
  if (!rows.length) {
    chart.innerHTML = '<p class="muted">No comparable thread data for this app.</p>';
    return;
  }
  const date = month => new Date(month + '-01T12:00:00Z').toLocaleDateString('en-US', {
    month:'short', timeZone:'UTC',
  });
  const duration = hours => hours >= 1 ? `${Math.round(hours * 10) / 10}h` : `${Math.round(hours * 60)}m`;
  $('thread-follow-data').innerHTML = rows.map(([month,d]) =>
    `<tr><th scope="row">${month}</th><td>${number(d.n)}</td><td>${number(d.prompts.median)}</td><td>${duration(d.user_activity_span.p90)}</td><td>${number(d.follow_up_day_later)} (${Math.round(1000*d.follow_up_day_later/d.n)/10}%)</td></tr>`
  ).join('');
  const w = chart.clientWidth;
  if (w < 110) return;
  const h = chart.clientHeight || 230;
  const left = 45, right = 13, top = 22, bottom = 32;
  const vh = h-top-bottom, step = (w-left-right)/rows.length;
  const highest = Math.max(0,...rows.map(([,d])=>d.user_activity_span.p90));
  const tick = highest > 12 ? Math.ceil(highest/12)*3 : Math.max(1,Math.ceil(highest/4));
  const max = tick*4;
  const width = Math.min(56,step*.65);
  const every = Math.max(1,Math.ceil(36/step));
  let svg = `<svg role="img" aria-label="Monthly 90th percentile human prompt span within the first week of a thread" viewBox="0 0 ${w} ${h}">`;
  for (let i=0;i<=4;i++) {
    const y=top+vh*(1-i/4);
    svg += `<line x1="${left}" x2="${w-right}" y1="${y}" y2="${y}"/><text x="${left-6}" y="${y+4}" text-anchor="end">${i*tick}h</text>`;
  }
  rows.forEach(([month,d],i)=>{
    const x=left+(i+.5)*step;
    const value=d.user_activity_span.p90;
    const height=vh*value/max;
    const y=top+vh-height;
    svg += `<rect x="${x-width/2}" y="${y}" width="${width}" height="${height}" rx="2" fill="var(--accent)"><title>${date(month)} · ${duration(value)} · ${number(d.n)} threads</title></rect>`;
    if (i%every===0 && (rows.length-1-i>=every||i===rows.length-1) || i===rows.length-1) {
      svg += `<text x="${x}" y="${h-12}" text-anchor="middle">${date(month)}</text>`;
    }
    if (i>=rows.length-2 && (step>=36||i===rows.length-1)) {
      svg += `<text x="${x}" y="${y-6}" text-anchor="middle">${duration(value)}</text>`;
    }
  });
  chart.innerHTML = svg+'</svg>';
}
