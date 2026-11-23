'use strict';
const names=Object.create(null);
const colors={codex:'var(--codex)',cursor:'var(--cursor)',claude:'var(--claude)'};
const taskNames={"all": "All prompts", "software_development": "Software development", "debugging": "Debugging", "agent_setup": "Agents & AI tools", "model_training": "Model development & fine-tuning", "data_analysis": "Data analysis", "research_learning": "Research & learning", "writing_communication": "Writing & communication", "creative_design": "Creative design", "infrastructure_operations": "Infrastructure & operations", "personal_planning": "Personal planning", "task_coordination": "Task coordination", "other_mixed": "Other / mixed", "unclear": "Unclear"};
let promptReact=null,agentIterations=null,metrics=null,threads=[],patternThreads=[],monthlyQual=[],qualTime=true,archive=[],selectedApp='all',selectedTask='all',page=0,archiveMode='prompts';
const size=24, $=id=>document.getElementById(id),number=n=>new Intl.NumberFormat('en-US').format(n),compact=n=>new Intl.NumberFormat('en-US',{notation:'compact',maximumFractionDigits:1}).format(n),escapeHtml=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function selectedApps(){return selectedApp==='all'?Object.keys(names):[selectedApp]}
function renderUsage(){if(!metrics)return;const apps=selectedApps();let prompts=0,conversations=0,words=0;for(const app of apps){const d=metrics.apps[app];prompts+=d.records;conversations+=d.threads;words+=d.words}
const stats=[[number(prompts),'Prompt records'],[number(conversations),'Conversations'],[(prompts/conversations).toFixed(1),'Prompts / conversation'],[(words/prompts).toFixed(0),'Words / prompt']];$('stats').innerHTML=stats.map(([n,label])=>`<div><span class="stat-value">${n}</span><span>${label}</span></div>`).join('');renderChart();renderTokenChart();renderQual();}
function renderChart() {
  if (!metrics) return;
  const chart = $('chart'), w = chart.clientWidth;
  if (w < 110) return;
  const measure = $('chart-measure').value;
  const apps = selectedApps();
  const months = [...new Set(apps.flatMap(app => Object.keys(metrics.apps[app].monthly)))].filter(validTrendMonth).sort();
  const values = months.map(month => {
    const rows = apps.map(app => metrics.apps[app].monthly[month]);
    if (measure !== 'words') return rows.map(d => d?.[measure] || 0);
    const prompts = rows.reduce((sum, d) => sum + (d?.prompts || 0), 0);
    const words = rows.reduce((sum, d) => sum + (d?.words || 0), 0);
    return [prompts ? words / prompts : 0];
  });
  const wordAverage = measure === 'words';
  const labels = wordAverage ? [apps.length > 1 ? 'All apps combined' : names[apps[0]]] : apps.map(app => names[app]);
  const fills = wordAverage && apps.length > 1 ? ['var(--accent)'] : apps.map(app => colors[app]);
  const h = chart.clientHeight || 230, left = 49, right = 12, top = 14, bottom = 36;
  const plotHeight = h - top - bottom, step = (w - left - right) / Math.max(months.length, 1);
  const max = Math.max(1, ...values.map(row => row.reduce((sum, v) => sum + v, 0))) * 1.08;
  const bar = Math.min(62, step * .62);
  const label = wordAverage ? 'words per prompt' : measure === 'threads' ? 'active conversations' : 'prompt records';
  let svg = `<svg role="img" aria-label="Monthly ${label}" viewBox="0 0 ${w} ${h}">`;
  for (let i = 0; i <= 4; i++) {
    const value = max * i / 4, y = top + plotHeight * (1 - i / 4);
    svg += `<line x1="${left}" x2="${w-right}" y1="${y}" y2="${y}"/><text x="${left-7}" y="${y+4}" text-anchor="end">${compact(value)}</text>`;
  }
  const every = Math.max(1, Math.ceil(44 / step));
  months.forEach((month, i) => {
    const x = left + step * (i + .5);
    let y = top + plotHeight;
    values[i].forEach((value, j) => {
      if (!value) return;
      const height = value / max * plotHeight;
      y -= height;
      svg += `<rect x="${x-bar/2}" y="${y}" width="${bar}" height="${height}" fill="${fills[j]}"><title>${labels[j]}, ${month}: ${number(Math.round(value))} ${label}</title></rect>`;
    });
    const last = months.length - 1;
    if (i === last || (i % every === 0 && last - i >= every)) {
      const date = new Date(month + '-01T12:00:00Z');
      const tick = date.toLocaleDateString('en-US', {month:'short', timeZone:'UTC'});
      const year = i === 0 || months[Math.max(0, i-every)].slice(0,4) !== month.slice(0,4) ? month.slice(0,4) : '';
      svg += `<text x="${x}" y="${h-18}" text-anchor="middle">${tick}</text>`;
      if (year) svg += `<text x="${x}" y="${h-3}" text-anchor="middle">${year}</text>`;
    }
  });
  chart.innerHTML = svg + '</svg>';
  $('legend').innerHTML = labels.map((name, i) => `<span><i class="swatch" style="background:${fills[i]}"></i>${name}</span>`).join('');
}
const useNames={model_training:'Model development & fine-tuning',software_development:'Software development',debugging:'Debugging',agent_setup:'Agents & AI tools',data_analysis:'Data analysis',research_learning:'Research & learning',writing_communication:'Writing & communication',creative_design:'Creative design',infrastructure_operations:'Infrastructure & operations',personal_planning:'Personal planning',task_coordination:'Task coordination',other_mixed:'Other / mixed',unclear:'Unclear',uncertain:'Uncertain'};
const feedbackNames={strongly_negative:'Strongly negative',negative:'Negative',mixed:'Mixed',positive:'Positive',strongly_positive:'Strongly positive',no_feedback:'No feedback signal',uncertain:'Uncertain'};
const steeringNames={none:'None observed',light:'Light',moderate:'Moderate',heavy:'Heavy',uncertain:'Uncertain'};
function effective(t,q){const a=t.answers[q];if(!a)return 'uncertain';if(q==='feedback'&&a.choice!=='no_feedback'&&(t.answers.feedback_present?.noul??0)<.5)return 'uncertain';return a.choice}
function distribution(id,counts,labels,total,order){const entries=order?order.map(k=>[k,counts[k]||0]):Object.entries(counts).sort((a,b)=>b[1]-a[1]);$(id).innerHTML=entries.filter(([,v])=>v>0||order).map(([k,v])=>`<div class="dist-row"><span>${labels[k]||k}</span><div class="dist-bar"><div class="dist-fill" style="width:${total?v/total*100:0}%;background:${['no_feedback','uncertain','none'].includes(k)?'#9faab4':'#76b3ff'}"></div></div><span class="dist-value" title="${v} of ${total} conversations">${total?(v/total*100).toFixed(1):'0'}%</span></div>`).join('')}
function renderQual(){if(!patternThreads.length)return;const ts=patternThreads.filter(t=>selectedApp==='all'||t.app===selectedApp),counts={use_case:{},feedback:{},steering:{}};for(const t of ts)for(const q of Object.keys(counts)){const label=effective(t,q);counts[q][label]=(counts[q][label]||0)+1}const explicit=ts.filter(t=>!['no_feedback','uncertain'].includes(effective(t,'feedback')));
const showAll=$('include-uninformative').checked;const uc=Object.fromEntries(Object.entries(counts.use_case).filter(([k])=>showAll||!['unclear','uncertain'].includes(k))),ucN=Object.values(uc).reduce((a,b)=>a+b,0);distribution('use-cases',uc,useNames,ucN);const feedbackOrder=showAll?['strongly_negative','negative','mixed','positive','strongly_positive','no_feedback','uncertain']:['strongly_negative','negative','mixed','positive','strongly_positive'];distribution('feedback-dist',counts.feedback,feedbackNames,showAll?ts.length:explicit.length,feedbackOrder);const steeringOrder=showAll?['none','light','moderate','heavy','uncertain']:['light','moderate','heavy'];const steeringN=showAll?ts.length:ts.filter(t=>['light','moderate','heavy'].includes(effective(t,'steering'))).length;distribution('steering-dist',counts.steering,steeringNames,steeringN,steeringOrder);if(qualTime)renderQualTime();else for(const id of ['use-cases','feedback-dist','steering-dist'])$(id).classList.remove('time-chart');renderFeedbackBySteering(explicit);
}

function renderFeedbackBySteering(explicit) {
  const picker = $('matrix-month');
  const previous = picker.value;
  const monthly = monthlyQual.filter(r => validTrendMonth(r.month) && (selectedApp === 'all' || r.app === selectedApp));
  const months = [...new Set(monthly.map(r => r.month))].sort();
  picker.innerHTML = '<option value="all">All time</option>' +
    months.map(month => `<option value="${month}">${month}</option>`).join('');
  picker.value = months.includes(previous) ? previous : 'all';
  const rows = picker.value === 'all' ? explicit : monthly.filter(r => r.month === picker.value);
  const labels = ['strongly_negative', 'negative', 'mixed', 'positive', 'strongly_positive'];
  const counts = Object.fromEntries(['none','light','moderate','heavy'].map(level =>
    [level, Object.fromEntries(labels.map(label => [label, 0]))]
  ));
  for (const row of rows) {
    const steering = effective(row, 'steering');
    const feedback = effective(row, 'feedback');
    if (counts[steering] && labels.includes(feedback)) counts[steering][feedback]++;
  }
  const chart = Object.entries(counts).map(([level, feedback]) => {
    const total = labels.reduce((sum, label) => sum + feedback[label], 0);
    const name = steeringNames[level];
    if (!total) return `<div class="feedback-row"><span>${name}</span><span class="muted">No feedback signals</span></div>`;
    const description = labels.map(label => `${feedbackNames[label]} ${(100 * feedback[label] / total).toFixed(1)}%`).join(', ');
    const segments = labels.filter(label => feedback[label]).map(label => {
      const share = 100 * feedback[label] / total;
      return `<span class="feedback-segment" style="width:${share}%;background:${feedbackColors[label]}" title="${feedbackNames[label]} · ${share.toFixed(1)}%">${share >= 14 ? `${Math.round(share)}%` : ''}</span>`;
    }).join('');
    return `<div class="feedback-row"><span>${name}</span><div class="feedback-track" role="img" aria-label="${name} steering: ${description}">${segments}</div></div>`;
  }).join('');
  const legend = labels.map(label =>
    `<span><i class="swatch" style="background:${feedbackColors[label]}"></i>${feedbackNames[label]}</span>`
  ).join('');
  $('feedback-by-steering').innerHTML = chart + `<div class="legend">${legend}</div>`;
}
function filtered(includeTask=true){if(archiveMode==='threads'){const q=$('search').value.trim().toLowerCase(),app=$('archive-app').value,f=$('feedback-filter').value,steering=$('steering-filter').value;return threads.filter(r=>(app==='all'||r.app===app)&&(!includeTask||selectedTask==='all'||r.task===selectedTask)&&(f==='all'||effective(r,'feedback')===f)&&(steering==='all'||effective(r,'steering')===steering)&&(!q||r.text.toLowerCase().includes(q)));}const q=$('search').value.trim().toLowerCase(),app=$('archive-app').value,domain=$('domain').value;return archive.filter(r=>(app==='all'||r.app===app)&&(domain==='all'||r.domain===domain)&&(!includeTask||selectedTask==='all'||r.task===selectedTask)&&(!q||r.text.toLowerCase().includes(q)));}
function renderArchive(){const base=filtered(false),counts={all:base.length};base.forEach(r=>counts[r.task]=(counts[r.task]||0)+1);$('buckets').innerHTML=Object.entries(archiveMode==='threads'?{all:'All conversations',...useNames}:taskNames).map(([key,name])=>`<button data-task="${key}" class="${selectedTask===key?'active':''}" aria-pressed="${selectedTask===key}"><span>${name}</span><span>${number(counts[key]||0)}</span></button>`).join('');const rs=filtered(),sort=$('sort').value;rs.sort((a,b)=>sort==='shortest'?a.words-b.words:sort==='longest'?b.words-a.words:sort==='oldest'?a.date.localeCompare(b.date):b.date.localeCompare(a.date));const pages=Math.max(1,Math.ceil(rs.length/size));page=Math.min(page,pages-1);$('result-count').textContent=`${number(rs.length)} ${archiveMode==='threads'?'conversations':'distinct prompt texts'}`;$('archive-total').textContent=`${number(archive.length)} distinct texts · ${number(metrics.total_records)} retained records`;$('results').replaceChildren();
for(const r of rs.slice(page*size,(page+1)*size)){const link=document.createElement('a');link.className='prompt-link';link.target='_blank';link.rel='noopener';link.href='reader.html?app='+encodeURIComponent(r.app)+'&'+(archiveMode==='threads'?'conversation':'prompt')+'='+encodeURIComponent(r.id);const meta=document.createElement('div');meta.className='prompt-meta';const label=document.createElement('span');label.className='app-label';label.style.color=colors[r.app];label.textContent=names[r.app];const date=document.createElement('span');date.textContent=(r.date||'').slice(0,7);const words=document.createElement('span');words.textContent=number(r.words)+' words';meta.append(label,date,words);if(archiveMode==='threads'){const n=document.createElement('span');n.textContent=r.prompt_count+' prompt records';meta.append(n)}else if(r.occurrences>1){const n=document.createElement('span');n.textContent=r.occurrences+' occurrences';meta.append(n)}const title=document.createElement('span');title.className='prompt-title';const text=(archiveMode==='threads'?r.text.replace(/^Human message 1\s*/,''):r.text).replace(/\s+/g,' ').trim();title.textContent=text.length>190?text.slice(0,190)+'…':text;const tags=document.createElement('div');tags.className='tag-list';const values=archiveMode==='threads'?[useNames[r.task]||r.task,feedbackNames[effective(r,'feedback')],steeringNames[effective(r,'steering')]]:[taskNames[r.task]||r.task,r.immediate_task?'Task: '+r.immediate_task:null,r.interaction];for(const t of values.filter(Boolean)){const el=document.createElement('span');el.textContent=t.replaceAll('_',' ');tags.append(el)}link.append(meta,title,tags);$('results').append(link)}if(!rs.length){const empty=document.createElement('p');empty.className='empty';empty.textContent='No prompts match these filters.';$('results').append(empty)}$('page-label').textContent=`Page ${page+1} of ${pages}`;$('prev').disabled=page===0;$('next').disabled=page===pages-1;}
$('app-controls').addEventListener('click',e=>{const b=e.target.closest('button[data-app]');if(!b)return;selectedApp=b.dataset.app;document.querySelectorAll('#app-controls button').forEach(el=>{el.classList.toggle('active',el===b);el.setAttribute('aria-pressed',String(el===b))});renderUsage()});$('chart-measure').addEventListener('change',renderChart);$('token-measure').addEventListener('change',renderTokenChart);$('qual-measure').addEventListener('change',renderQual);$('matrix-month').addEventListener('change',renderQual);for(const v of ['time','overall'])$('qual-'+v).addEventListener('click',()=>{qualTime=v==='time';$('qual-time').classList.toggle('active',qualTime);$('qual-overall').classList.toggle('active',!qualTime);$('qual-time').setAttribute('aria-pressed',String(qualTime));$('qual-overall').setAttribute('aria-pressed',String(!qualTime));renderQual()});$('include-uninformative').addEventListener('change',renderQual);let resizeTimer;window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{renderChart();renderTokenChart();renderQual()},100)});$('buckets').addEventListener('click',e=>{const b=e.target.closest('button[data-task]');if(!b)return;selectedTask=b.dataset.task;page=0;renderArchive()});for(const id of ['search','archive-app','domain','sort','feedback-filter','steering-filter'])$(id).addEventListener(id==='search'?'input':'change',()=>{page=0;renderArchive()});$('prev').addEventListener('click',()=>{page--;renderArchive();$('archive').scrollIntoView({behavior:'smooth'})});$('next').addEventListener('click',()=>{page++;renderArchive();$('archive').scrollIntoView({behavior:'smooth'})});$('reset').addEventListener('click',()=>{$('search').value='';$('archive-app').value='all';$('domain').value='all';$('sort').value='newest';selectedTask='all';$('feedback-filter').value='all';$('steering-filter').value='all';page=0;renderArchive()});
function setArchiveMode(mode){archiveMode=mode;selectedTask='all';page=0;for(const v of ['prompts','threads']){$('view-'+v).classList.toggle('active',v===mode);$('view-'+v).setAttribute('aria-pressed',String(v===mode))}document.querySelectorAll('.thread-filter').forEach(el=>el.hidden=mode!=='threads');$('domain').disabled=mode==='threads';renderArchive()}
$('view-prompts').addEventListener('click',()=>setArchiveMode('prompts'));$('view-threads').addEventListener('click',()=>setArchiveMode('threads'));
function setUpApps() {
  Object.assign(names,metrics.app_names);
  const palette=['#2464a0','#8f4d83','#1e7967','#ad6b30','#6654a4'];
  Object.keys(names).forEach((app,i)=>{
    colors[app] ??= palette[i % palette.length];
    const button=document.createElement('button');
    button.dataset.app=app;
    button.setAttribute('aria-pressed','false');
    button.textContent=names[app];
    $('app-controls').append(button);
    $('archive-app').add(new Option(names[app],app));
  });
}
async function load(){try{const response=await fetch('metrics.json',{cache:'no-cache'});if(!response.ok)throw Error('metrics');metrics=await response.json();setUpApps();const telemetry=await Promise.allSettled(['agent-iterations.json','prompt-react.json'].map(async url=>{const r=await fetch(url,{cache:'no-cache'});if(!r.ok)throw Error(url);return r.json();}));agentIterations=telemetry[0].value??null;promptReact=telemetry[1].value??null;renderUsage();$('method-details').innerHTML=`<p>Snapshot: ${new Date(metrics.snapshot+'T12:00:00Z').toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric',timeZone:'UTC'})}. ${number(metrics.total_records)} retained prompt records across ${number(metrics.total_threads)} conversations; ${number(metrics.unique_texts)} distinct prompt texts. ${number(metrics.cleaned_texts)} texts passed the publication checks. ${metrics.withheld_texts?number(metrics.withheld_texts)+' texts were withheld by the credential gate.':'No texts were withheld by the credential gate.'}</p><p>Qualitative labels use cleaned human messages in chronological order. The charts show counts of conversations, not a survey or an objective success rate. The most likely automated category is shown. Default qualitative distributions exclude missing or ambiguous signals and show their coverage. ${number(metrics.qual_excerpted)} conversations were excerpted for qualitative analysis.</p><p>Archive source labels identify the app; exact session identifiers, original paths and private source filenames are omitted. Inference and classification took place before this static snapshot was published. Credential checks are mandatory and yielded zero residual matches in the publication data.</p>`;
const coverageResponse=await fetch('coverage.json',{cache:'no-cache'});
if(coverageResponse.ok){const coverage=await coverageResponse.json();const rows=[];for(const [app,months] of Object.entries(coverage.apps||{})){for(const [month,cell] of Object.entries(months)){rows.push(`<tr><td>${names[app]||app}</td><td>${month}</td><td>${number(cell.prompts)}</td><td>${number(cell.threads)}</td><td>${number(cell.responses)}</td><td>${number(cell.with_tokens)}</td></tr>`)}}const unavailable=(coverage.unavailable||[]).map(x=>`<li>${x}</li>`).join('');$('method-details').insertAdjacentHTML('beforeend',`<h4>Source coverage</h4><div class="table-wrap"><table><thead><tr><th>Agent</th><th>Month</th><th>Human prompts</th><th>Threads</th><th>Responses</th><th>With token counters</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>${unavailable?`<p>Agents detected without readable history: ${unavailable}</p>`:''}`)}
const qual=await fetch('conversations.json',{cache:'no-cache'});if(!qual.ok)throw Error('qualitative');threads=await qual.json();const patterns=await fetch('conversation-labels.json',{cache:'no-cache'});patternThreads=patterns.ok?await patterns.json():threads;const monthlyResponse=await fetch('qualitative-monthly.json',{cache:'no-cache'});if(monthlyResponse.ok)monthlyQual=await monthlyResponse.json();renderQual();const payloads=await Promise.all(Object.keys(names).map(async app=>{const r=await fetch('prompts-'+app+'.json',{cache:'no-cache'});if(!r.ok)throw Error(app);return r.json()}));archive=payloads.flat();$('view-prompts').disabled=false;$('view-threads').disabled=false;const byId=new Map(archive.map(r=>[r.id,r]));for(const t of threads){const msgs=t.prompt_ids.map(id=>byId.get(id)).filter(Boolean);t.task=effective(t,'use_case');t.date=t.date||msgs[0]?.date||'';t.words=msgs.reduce((n,r)=>n+r.words,0);t.text=msgs.map((r,i)=>`Human message ${i+1}\n${r.text}`).join('\n\n────────────────────\n\n');}renderArchive();window.fieldnotesDataReady=true;window.dispatchEvent(new Event('fieldnotes-data-ready'));}catch(e){$('result-count').textContent='The archive could not load. Refresh to try again.';$('archive-total').textContent='Archive temporarily unavailable';console.error('Site data load failed',e.message)}}load();

const trackUsageSize = new ResizeObserver(entries => {
  if (!metrics || !entries.some(entry => entry.contentRect.width > 0)) return;
  requestAnimationFrame(() => {renderChart();renderTokenChart();});
});
document.querySelectorAll('#usage .chart').forEach(chart => trackUsageSize.observe(chart));

$('horizon-measure').addEventListener('change', renderWorkHorizon);
$('horizon-weight').addEventListener('change', renderWorkHorizon);
