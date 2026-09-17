// Structured facts stay drafts until an explicit version-bound confirmation in WeCom.
const rpUrl=(userId,week)=>typeof mwRoute==='function'?`#/employee/${encodeURIComponent(userId)}/${week}`:`#/records/week/${encodeURIComponent(userId)}/${week}`;
const rpRoot=(userId,week)=>`/api/v1/reporting/weeks/${encodeURIComponent(userId)}/${week}`;
// randomUUID is unavailable on some HTTP browsers because it requires a secure context.
// These values are only DOM names and idempotency keys, never authentication secrets.
function rpRequestId() {
  if(globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const values=new Uint32Array(4);
  if(globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(values);
  else values.forEach((_,index)=>{values[index]=Math.floor(Math.random()*0x100000000);});
  return `web-${Date.now().toString(36)}-${[...values].map(value=>value.toString(16).padStart(8,'0')).join('')}`;
}
async function rpDownload(title) {
  // Freeze only currently displayed report content; no login tokens, API calls or external assets.
  const content=app.cloneNode(true);
  const selectors=app.querySelectorAll('.rp-select-input');
  content.querySelectorAll('.rp-select-input').forEach((node,i)=>{if(selectors[i].checked) node.setAttribute('checked','');else node.removeAttribute('checked');});
  content.querySelectorAll('button,form,input:not(.rp-select-input),select,textarea,.back,.ws-related,.rp-online-only').forEach(node=>node.remove());
  content.querySelectorAll('a').forEach(node=>node.replaceWith(document.createTextNode(node.textContent)));
  const doc=document.implementation.createHTMLDocument(title),meta=doc.createElement('meta');doc.documentElement.lang='zh-CN';meta.name='viewport';meta.content='width=device-width, initial-scale=1';doc.head.append(meta);
  const charset=doc.createElement('meta');charset.setAttribute('charset','UTF-8');doc.head.prepend(charset);
  const style=doc.createElement('style');
  const sheets=await Promise.all(['style.css','crm.css','workspace.css','review-design.css'].map(async path=>{const res=await fetch(path);if(!res.ok)throw new Error('样式读取失败，请稍后重试');return res.text();}));
  style.textContent=sheets.join('\n')+'\nbody{background:#f5f7fa}main.content{max-width:900px;width:100%;margin:auto;padding:24px 16px}.rp-item[open]{break-inside:auto}.rp-offline-feedback{display:block}';doc.head.append(style);
  const note=doc.createElement('p');note.textContent='离线周报快照 · 不会自动更新。查看员工详情或提交反馈，请打开本地工作平台。';note.className='notice';content.append(note);doc.body.append(doc.importNode(content,true));
  const url=URL.createObjectURL(new Blob(['<!DOCTYPE html>\n'+doc.documentElement.outerHTML],{type:'text/html;charset=utf-8'}));
  const link=document.createElement('a');link.href=url;link.download=title.replace(/[\\/:*?"<>|]/g,'-')+'.html';link.click();window.setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function rpDownloadButton(title) {return crmButton('下载周报 HTML',()=>rpDownload(title).catch(error=>notify(error.message)),'secondary-button');}
function rpMeter(value) {
  const row=el('span','rp-meter');
  if(value==null) return el('span','muted','未知');
  const bar=el('progress');bar.max=100;bar.value=value;bar.setAttribute('aria-label',`完成${value}%`);row.append(bar,el('span','',`${value}%`));return row;
}
function rpLast(item,date=crmDate()) {return (item.days||[]).filter(day=>day.date<=date).at(-1);}
function rpSummary(progress,date=crmDate()) {
  const items=(progress?.items||[]).filter(item=>!item.retired),done=items.filter(item=>rpLast(item,date)?.progressValue>=100);
  const pending=items.filter(item=>rpLast(item,date)?.progressValue!=null&&rpLast(item,date).progressValue<100),unknown=items.length-done.length-pending.length;
  return el('p','rp-week-summary',items.length?`本周${done.length?`已完成${done.map(item=>item.name).join('、')}`:'事项正在推进'}${pending.length?`，${pending.map(item=>item.name).join('、')}仍需跟进`:''}${unknown?`，另有${unknown}项进度待明确`:''}。`:'本周尚未设置工作计划。');
}
function rpFeedbackTop(feedback=[],report=null,canFeedback=false,edit=rpFeedback) {
  const section=el('section','rp-feedback-top');
  if(!feedback.length&&!canFeedback) return section;
  section.append(el('h3','section-title','老板反馈'));
  for(const f of [...feedback].sort((a,b)=>String(b.updated_at||b.created_at||'').localeCompare(String(a.updated_at||a.created_at||'')))) {
    const block=el('div','ws-feedback');block.append(el('p','muted',`${f.manager_name||'老板'}${f.created_at?` · ${crmTime(f.updated_at||f.created_at)}`:''} · 修订 ${f.revision||1}`),el('p','ws-prose',f.content));
    if(canFeedback&&f.manager_user_id===WS_SESSION?.userId) block.append(crmButton('修改反馈',()=>edit(report,f),'quiet-button'));
    for(const revision of f.revisions||[]) {const old=el('details');old.append(el('summary','',`历史修订 ${revision.version||revision.revision}`),el('p','ws-prose',revision.content));block.append(old);}
    section.append(block);
  }
  if(canFeedback) section.append(crmButton(typeof mwRoute==='function'?'写反馈':'新增管理反馈',()=>edit(report,null),'primary-button'));
  return section;
}
function rpTimeline(progress,asOfDate=crmDate(),snapshot=null,editReason=null) {
  const wrapper=el('section','rp-mobile-report');
  for(const item of progress.items) {
    const detail=el('details','rp-item'),heading=el('summary','rp-item-heading');
    detail.open=false;
    const last=item.days.filter(d=>d.date<=asOfDate).at(-1);
    const itemName=snapshot?.items?.find(row=>row.id===item.workItemId)?.name||item.name;
    const identity=el('div','rp-item-identity');
    identity.append(el('strong','',`${itemName}${item.retired?'（已移除，保留历史）':''}`));
    if(item.metric?.mode==='count') {const target=el('small','rp-target',`${last?.completedCount==null?'—':last.completedCount}/${item.metric.total}${item.metric.unit}`);target.title=`完成${last?.completedCount==null?'待明确':last.completedCount}，计划${item.metric.total}${item.metric.unit}`;identity.append(target);}
    heading.append(identity,rpMeter(last?.progressValue));
    const keyInfo=snapshot?.reasons?.find(reason=>reason.workItemId===item.workItemId)?.content||item.days.filter(day=>day.date<=asOfDate&&day.progressText?.trim()&&!/^(?:暂无|无|没有)新?进展[。\s]*$/.test(day.progressText.trim())).at(-1)?.progressText;
    if(keyInfo) heading.append(el('span','rp-item-key',keyInfo));
    detail.append(heading);
    const metric=item.metric,body=el('div','rp-item-body');
    let background=item.planBackground||snapshot?.items?.find(row=>row.id===item.workItemId)?.plan_background;
    const repeatedPlan=metric?.mode==='count'?`${itemName}${metric.total}${metric.unit}`:'';
    if(background&&repeatedPlan&&background.startsWith(repeatedPlan)&&/^[。；;\s]*$/.test(background.slice(repeatedPlan.length, repeatedPlan.length+1))) background=background.slice(repeatedPlan.length).replace(/^[。；;\s]+/,'');
    if(background) body.append(el('p','rp-background',background));
    const days=el('ol','rp-days');
    item.days.forEach(day=>{
      if(day.date>asOfDate) return;
      const source=snapshot?.confirmed?.find(report=>report.report_date===day.date);
      const facts=day.progressText||wsJson(source?.progress_json).filter(entry=>entry.workItemRef===item.workItemId).map(entry=>entry.progressText).join('\n');
      if(!facts.trim()||/^(?:今日|当天|本日)?(?:暂无|没有|无|未记录)(?:新的?|实际)?(?:工作)?进展[。！\s]*$/u.test(facts.trim())) return;
      const row=el('li','rp-day'),head=el('div','rp-day-head');
      head.append(el('span','rp-day-date',day.date.slice(5)),el('span','rp-day-value',day.progressValue==null?'':`${day.progressValue}%`));
      row.append(head,el('p','ws-prose',facts));
      days.append(row);
    });
    if(days.children.length) body.append(days);
    else body.append(el('p','muted','本周尚无已确认进展。'));
    const reason=snapshot?.reasons?.find(reason=>reason.workItemId===item.workItemId);
    if(reason?.content) {const analysis=el('div','rp-analysis');analysis.append(el('span','','分析与后续'),el('p','ws-prose',reason.content));body.append(analysis);}
    if(editReason) body.append(crmButton(reason?.content?'修改分析':'补充分析',()=>editReason(item),'quiet-button'));
    detail.append(body);
    if(item.questions?.length) body.append(el('p','notice',item.questions.join('；')));wrapper.append(detail);
  }
  if(!progress.items.length) wrapper.append(el('p','muted','尚无周计划事项。'));return wrapper;
}
// Native radio controls keep card drilldowns usable in exported HTML without scripts.
function rpSelector(options,kind) {
  const root=el('div',`rp-selector ${kind}`),name='rp-'+rpRequestId();
  options.forEach((option,index)=>{
    const input=el('input','rp-select-input');input.type='radio';input.name=name;input.id=name+'-'+index;
    input.setAttribute('aria-label',option.label);if(index===0){input.checked=true;input.setAttribute('checked','');}
    const label=el('label',`rp-select-card${option.compact?' rp-select-compact':''}`);label.setAttribute('for',input.id);
    if(option.compact){const heading=el('span','rp-card-heading');heading.append(el('span','',option.label));if(option.headingMeta)heading.append(el('small','rp-heading-meta',option.headingMeta));else if(option.deltaValue)heading.append(el('small','rp-compare-label','周环比 数/PP'));label.append(heading);}
    else label.append(el('span','',option.label));
    if(option.compact){const metrics=el('span','rp-card-metrics');if(option.value!=null)metrics.append(el('strong','',option.value));if(option.rate)metrics.append(el('small','rp-current-rate',option.rate));if(option.note)metrics.append(el('small','muted',option.note));if(option.deltaValue){const comparison=el('span','rp-card-comparison');comparison.title=option.deltaTitle||'';comparison.append(el('small','rp-compare',option.deltaValue));if(option.deltaRate)comparison.append(el('small','rp-compare',option.deltaRate));metrics.append(comparison);}else if(option.delta)metrics.append(el('small','rp-compare',option.delta));label.append(metrics);}
    else {if(option.value!=null)label.append(el('strong','',option.value));if(option.note)label.append(el('small','muted',option.note));if(option.delta)label.append(el('small','rp-compare',option.delta));}
    const panel=el('section','rp-select-panel');panel.append(option.body);
    root.append(input,label,panel);
  });return root;
}
function rpTeamActions(row,week) {
  const actions=el('div','rp-team-actions');
  if(!row.restricted) {
    const button=crmButton('反馈',async()=>{
      try {
        const data=await fetchJson(rpRoot(row.userId,row.weekId||week)),report=data.detail.currentReport||data.detail.report;
        if(!data.canFeedback)return notify('当前无权给该员工反馈。');
        if(!report)return notify('该员工本周尚无周报，请先生成周报后反馈。');
        rpFeedback(report,null);
      }catch(error){notify(error.message);}
    },'quiet-button rp-online-only');actions.append(button);
  }
  return actions;
}
function rpBusinessEntry(entry,week) {
  const {row,item,last}=entry,block=el('article','rp-business-item');
  const fact=item.days.filter(day=>day.date<=crmDate()&&day.progressText?.trim()&&!/^(?:暂无|无|没有)新?进展[。\s]*$/.test(day.progressText.trim())).at(-1);
  const detail=el('div','rp-business-copy');
  const line=el('p',fact?'rp-business-fact':'muted');
  line.append(wsLink(`${row.name}：`,rpUrl(row.userId,row.weekId||week),'rp-employee-name rp-business-name'),el('span','',fact?fact.progressText:'暂无已确认的具体进展。'));
  detail.append(line);
  const reason=row.reasons?.find(reason=>reason.workItemId===item.workItemId)?.content;
  if(reason)detail.append(el('p','rp-business-next',`待跟进 · ${reason}`));
  block.append(detail);return block;
}
function rpTaskName(name) {const base=name.split(/[，,｜|]/)[0].trim();return ({'走访企业':'企业走访','合同梳理':'梳理合同','活动开展':'开展活动'})[base]||base;}
function rpDelta(current,previous,unit) {
  if(previous==null)return '周环比—';
  const delta=current-previous;
  return `周环比${delta>0?'+':''}${delta}${unit||''}`;
}
function rpRate(value,total) {return total>0?Math.round(value*100/total):0;}
function rpComparison(current,currentTotal,previous,previousTotal,unit='') {
  if(previous==null||previousTotal==null)return {absolute:'—',rate:null};
  const delta=current-previous,rate=rpRate(current,currentTotal)-rpRate(previous,previousTotal);
  return {absolute:`${delta>0?'+':''}${delta}${unit}`,rate:`/${rate>0?'+':''}${rate}PP`,title:`完成数周环比${delta>0?'+':''}${delta}${unit}；完成率周环比${rate>0?'+':''}${rate}个百分点`};
}
function rpPersonOverview(row) {
  if(row.restricted)return '工作明细暂不可查看。';
  const items=(row.progress?.items||[]).filter(item=>!item.retired);
  const facts=items.map(item=>{const last=(item.days||[]).filter(day=>day.date<=crmDate()&&day.progressText?.trim()).at(-1);return last?`${rpTaskName(item.name)}：${last.progressText}`:null;}).filter(Boolean);
  return facts.length?facts.join('；'):'暂无已确认的工作内容。';
}
function rpManagerReport(rows,week) {
  const root=el('section','rp-manager-report'),staff=rows.filter(row=>row.userId!==WS_SESSION?.userId);
  const entries=staff.filter(row=>!row.restricted).flatMap(row=>(row.progress?.items||[]).filter(item=>!item.retired).map(item=>({row,item,last:rpLast(item)})));
  // Only explicit equivalent names are normalized; unrelated tasks and different units are never added together.
  const groups=new Map();
  for(const entry of entries) {
    const title=rpTaskName(entry.item.name),metric=entry.item.metric;
    const key=JSON.stringify([title,metric?.mode,metric?.unit]);
    if(!groups.has(key))groups.set(key,{title,metric,entries:[]});groups.get(key).entries.push(entry);
  }
  const order=['企业走访','梳理合同','开展活动','业务学习'];
  const taskOptions=[...groups.values()].sort((a,b)=>(order.includes(a.title)?order.indexOf(a.title):99)-(order.includes(b.title)?order.indexOf(b.title):99)).map(group=>{
    const body=el('div','rp-business-list');
    group.entries.forEach(entry=>body.append(rpBusinessEntry(entry,week)));
    const count=group.metric?.mode==='count',total=count?group.entries.reduce((n,e)=>n+e.item.metric.total,0):group.entries.length;
    const unknown=group.entries.filter(e=>count?e.last?.completedCount==null:e.last?.progressValue==null).length;
    const done=group.entries.reduce((n,e)=>n+(count?(e.last?.completedCount??0):(e.last?.progressValue>=100?1:0)),0);
    const previous=[...new Map(group.entries.map(entry=>[entry.row.userId,entry.row])).values()].map(row=>{
      if(!row.previousProgress||!row.previousAsOf)return null;
      const items=row.previousProgress.items.filter(item=>!item.retired&&rpTaskName(item.name)===group.title&&item.metric?.mode===group.metric?.mode&&item.metric?.unit===group.metric?.unit);
      if(!items.length)return null;
      const points=items.map(item=>rpLast(item,row.previousAsOf));
      if(points.some(point=>count?point?.completedCount==null:point?.progressValue==null))return null;
      const current=group.entries.filter(entry=>entry.row.userId===row.userId);
      if(current.some(entry=>count?entry.last?.completedCount==null:entry.last?.progressValue==null))return null;
      return {previous:points.reduce((n,point)=>n+(count?point.completedCount:point.progressValue>=100?1:0),0),
        previousTotal:count?items.reduce((n,item)=>n+item.metric.total,0):items.length,
        current:current.reduce((n,entry)=>n+(count?entry.last.completedCount:entry.last.progressValue>=100?1:0),0),
        currentTotal:count?current.reduce((n,entry)=>n+entry.item.metric.total,0):current.length};
    });
    const paired=previous.filter(value=>value!==null),comparison=paired.length?paired.reduce((n,value)=>n+value.previous,0):null;
    const delta=rpComparison(paired.reduce((n,value)=>n+value.current,0),paired.reduce((n,value)=>n+value.currentTotal,0),comparison,paired.length?paired.reduce((n,value)=>n+value.previousTotal,0):null);
    return {label:group.title,value:`${done}/${total}`,rate:`·${rpRate(done,total)}%`,deltaValue:delta.absolute,deltaRate:delta.rate,deltaTitle:delta.title,compact:true,body};
  });
  const taskBody=taskOptions.length?rpSelector(taskOptions,'rp-task-selector'):el('p','notice','暂无可查看的工作事项。');
  const bucket=(row,previous=false)=>{
    const assigned=previous?(row.previousProgress?.items||[]).filter(item=>!item.retired).map(item=>({last:rpLast(item,row.previousAsOf)})):entries.filter(e=>e.row.userId===row.userId);
    if(row.restricted||!assigned.length||assigned.some(e=>e.last?.progressValue==null))return '进度待确认';
    if(assigned.every(e=>e.last.progressValue>=100))return '全部完成';
    if(assigned.every(e=>e.last.progressValue>=80))return '各项达到80%';
    return '仍有事项低于80%';
  };
  const peopleOptions=['全部完成','各项达到80%','仍有事项低于80%','进度待确认'].map(label=>{
    const selected=label==='全部员工'?staff:staff.filter(row=>bucket(row)===label),body=el('div','rp-people-list');
    const previousCount=staff.length&&staff.every(row=>row.previousProgress?.items?.length&&row.previousAsOf)?staff.filter(row=>bucket(row,true)===label).length:null;
    const peopleDelta=previousCount==null?null:selected.length-previousCount;
    for(const row of selected) {
      const card=el('article','rp-person'),copy=el('div','rp-business-copy'),overview=el('p',row.restricted?'notice':'rp-employee-overview');
      overview.append(wsLink(`${row.name}：`,rpUrl(row.userId,row.weekId||week),'rp-employee-name rp-person-name'),el('span','',row.restricted?'当前无权查看工作明细，未纳入完成统计。':rpPersonOverview(row)));
      copy.append(overview);
      if(!row.restricted) {
        const reasons=(row.reasons||[]).filter(reason=>reason.content).map(reason=>reason.content);
        if(reasons.length)copy.append(el('p','rp-business-next',`重点跟进 · ${reasons.join('；')}`));
      }
      card.append(copy);
      body.append(card);
    }
    if(!selected.length)body.append(el('p','muted','暂无符合条件的员工。'));
    const delta=rpComparison(selected.length,staff.length,previousCount,previousCount==null?null:staff.length,'人');
    return {label,headingMeta:`员工${selected.length}${peopleDelta==null?'':` · 周环比${peopleDelta>0?'+':''}${peopleDelta}`}`,value:`${selected.length}/${staff.length}`,rate:`·${rpRate(selected.length,staff.length)}%`,deltaValue:delta.absolute,deltaRate:delta.rate,deltaTitle:delta.title,compact:true,body};
  });
  root.append(rpSelector([{label:'事项视角',body:taskBody},{label:'员工视角',body:rpSelector(peopleOptions,'rp-people-selector')}],'rp-view-selector'));
  return root;
}
async function rpWeeks(search='') {
  const params=new URLSearchParams(search),companyId=params.get('companyId')||'', week=crmInput(params.get('weekId')||wsMonday(),'date'),person=wsPeopleFilter(params.get('userId')||'');
  const form=el('form','ws-filters rp-week-filters'),submit=el('button','secondary-button','查询');submit.type='submit';if(WS_VIEW==='team') form.append(labeled('人员',person));form.append(labeled('自然周',week),submit);
  form.addEventListener('submit',event=>{event.preventDefault();location.hash=`#/records/weekly?${wsQuery({weekId:wsMonday(week.value),userId:person.value,companyId})}`;});
  const data=await fetchJson(`/api/v1/reporting/weeks?${wsQuery({weekId:wsMonday(week.value),userId:person.value,companyId})}`);
  const manager=WS_VIEW==='team'&&WS_CONTEXT?.canManageTeam;
  app.replaceChildren(pageHeading(manager?'团队周报':'周报与反馈',manager?'本周工作推进、未完成原因与后续安排。':'一人一周一个入口，版本和对应反馈在详情保留。'),wsRecordTabs('weekly',search),form);
  if(WS_SESSION?.demoLabel)app.append(el('p','notice',WS_SESSION.demoLabel));
  if(companyId) app.append(el('p','notice','当前只列出与选定企业有明确来源关联的人员周报。周报详情仍按完整自然周展示。'),wsLink('取消企业筛选',`#/records/weekly?weekId=${wsMonday(week.value)}`));
  if(manager) app.append(rpManagerReport(data.rows,wsMonday(week.value)),rpDownloadButton(`团队周报-${wsMonday(week.value)}`));
  else app.append(wsTable(['人员','自然周','已确认天数','状态','当前版本','操作'],data.rows.map(row=>[row.name,row.weekId,`${row.confirmedDays}天`,row.instance?.stale?'来源已变更，待重生成':row.report?'已生成':'尚未生成',row.report?`v${row.report.version}`:'—',wsLink('查看本周',rpUrl(row.userId,row.weekId))]),'暂无当前权限范围内的人员。',true));
}
async function rpWeek(userId,week) {
  const data=await fetchJson(rpRoot(userId,week)),detail=data.detail;
  const report=detail.currentReport||detail.report||null, instance=detail.instance||{};
  const actions=el('div','person-actions');
  if(data.canGenerate) actions.append(crmButton(report?'重新生成周报':'生成周报',async()=>{try{await fetchJson(`${rpRoot(userId,week)}/generate`,{method:'POST',body:'{}'});await wsRefresh();}catch(error){notify(error.message);}},'primary-button'));
  if(data.canEditReason) actions.append(crmButton('填写整周分析',()=>rpReason(userId,week,null,detail.reasons||[])));
  app.replaceChildren(wsLink('← 周报列表',`#/records/weekly?weekId=${week}`,'back'),pageHeading(`${data.name} · ${week} 周报`,'周一至周日；所有生成版本和反馈保留在同一个入口。',actions));
  app.append(rpFeedbackTop(detail.feedback||[],report,Boolean(report&&data.canFeedback)),rpSummary(data.progress));
  if(instance.stale) app.append(el('p','notice warning','正式记录、目标、分析或模板已变化；以下已生成周报尚未更新。查看最新进度后请重新生成。'));
  if(report) {const archive=el('details','rp-archive');archive.append(el('summary','',`已发布版本 v${report.version}`),el('p','ws-prose',report.content),wsLink(`查看当前发布快照 v${report.version}`,`#/records/weekly/${report.id}`));app.append(archive);}
  else app.append(el('p','notice','本周尚未生成周报。无日报不代表已完成或进度为0。'));
  app.append(el('p','muted','当前已确认进度（可能晚于已生成周报）'),rpTimeline(data.progress,crmDate(),{reasons:detail.reasons||[]},data.canEditReason?item=>rpReason(userId,week,{id:item.workItemId,name:item.name},detail.reasons||[]):null));
  const reasons=detail.reasons||[];
  const overall=reasons.find(reason=>!reason.workItemId);if(overall?.content) app.append(el('h3','section-title','整周总体分析'),el('p','ws-prose',overall.content));
  const history=detail.history||detail.versions||[];
  const versions=el('details','rp-archive');versions.append(el('summary','','发布历史'),wsTable(['版本','生成时间','操作'],history.map(r=>[`v${r.version}`,crmTime(r.generated_at),wsLink('查看快照与反馈',`#/records/weekly/${r.id}`)]),'暂无已生成版本。'));app.append(versions);
}
function rpReason(userId,week,item,reasons) {
  const itemId=item?.id??null, previous=reasons.find(r=>(r.workItemId??r.work_item_id??null)===itemId);
  crmModal(itemId?`${item.name} · 整周原因`:'整周总体分析','原因独立留存并保留修订，修改不会伪造某一天的工作事实。',grid=>{
    const content=crmField(grid,'分析原因 / 未完成说明 / 后续安排',crmText(previous?.content||'',6000),true);content.required=true;
    return()=>({workItemId:itemId,content:content.value,expectedVersion:previous?.version||0});
  },async body=>{await fetchJson(`${rpRoot(userId,week)}/reason`,{method:'PUT',body:JSON.stringify(body)});await wsRefresh();},'保存分析');
}
async function rpVersion(id) {
  const data=await fetchJson(`/api/v1/workspace/weekly-reports/${encodeURIComponent(id)}`),r=data.report;
  app.replaceChildren(wsLink('← 本周所有版本',rpUrl(r.user_id,r.week_id),'back'),pageHeading(`${r.user_name} · ${r.week_id} 周报 v${r.version}`,`不可变发布快照 · ${crmTime(r.generated_at)}`),wsRelatedCompanies(data.companies));
  app.append(rpFeedbackTop(data.feedback||[],r,data.canFeedback));
  if(data.progressSnapshot) app.append(rpSummary(data.progressSnapshot,new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(r.generated_at))));
  app.append(rpDownloadButton(`${r.user_name}-${r.week_id}-周报-v${r.version}`));
  if(!data.progressSnapshot) {app.append(el('p','ws-prose',r.content));for(const part of wsJson(r.sections_json).filter(part=>!/交流|老板反馈|领导反馈/.test(part.title))) app.append(el('h3','section-title',part.title),el('p','ws-prose',part.body));}
  if(data.progressSnapshot) app.append(rpTimeline(data.progressSnapshot,new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(r.generated_at)),data.sourceSnapshot));
  const overall=data.sourceSnapshot?.reasons?.find(reason=>!reason.workItemId);if(overall) app.append(el('h3','section-title','整周总体分析'),el('p','ws-prose',overall.content));
  const sources=el('div','ws-related');wsJson(r.cited_report_ids_json).forEach((source,i)=>sources.append(wsLink(`来源日报 ${i+1}`,`#/records/daily/${source}`)));app.append(sources);
}
function rpFeedback(report,previous) {
  const requestId=rpRequestId();
  crmModal(previous?'修改反馈':'写反馈',WS_SESSION?.weeklyDemo?'反馈保存后可在周报中查看和修改。':'反馈保存后通知员工，可在此查看和修改。',grid=>{
    const input=crmField(grid,'反馈内容',crmText(previous?.content||'',10000),true);input.required=true;
    return()=>({weeklyReportId:report.id,content:input.value,...(previous?{expectedVersion:previous.revision||1}:{})});
  },async body=>{await fetchJson(`/api/v1/reporting/feedback${previous?`/${previous.id}`:''}`,{method:previous?'PUT':'POST',headers:{'Idempotency-Key':requestId},body:JSON.stringify(body)});await wsRefresh();},WS_SESSION?.weeklyDemo?'保存反馈':'保存并通知');
}
async function rpDailyTools(report) {
  const data=await fetchJson(`/api/v1/reporting/daily/${report.id}`);
  if(data.questions.length) app.append(el('p','notice',`待补充：${data.questions.join('；')}。通过修改补充事实，未明确的进度不会当作0。`));
  if(data.canEdit) app.append(crmButton('补充 / 手调事项进展',()=>rpDraftEditor(data,report),'secondary-button'));
}
async function rpDraftEditor(detail,report) {
  const date=report?.report_date||crmDate(),week=wsMonday(date),requestId=rpRequestId();
  if(!detail) {
    if(report) detail=await fetchJson(`/api/v1/reporting/daily/${report.id}`);
    else {const plans=await fetchJson(`/api/v1/workspace/items?weekId=${week}`),types=await fetchJson('/api/v1/reporting/types');detail={items:await Promise.all(plans.items.filter(i=>i.user_id===WS_CONTEXT.me.id).map(async item=>({...item,...await fetchJson(`/api/v1/reporting/metrics/${item.id}`)}))),types:types.types,currentReportId:null};}
  }
  if(!detail.items.length) return notify('请先新增本人周计划事项，再填写进展。');
  const existing=wsJson(report?.progress_json),controls=[];
  crmModal('填写事项进展',`${date} · 这是当日完整草稿，保留已填事项以免遗漏。先保存，回企微发送“我的日报 ${date}”核对后确认；不会直接入库。`,grid=>{
    const summary=crmField(grid,'当日事实摘要 *',crmText(report?.summary||'',6000),true);summary.required=true;
    for(const item of detail.items) {
      const old=existing.find(p=>p.workItemRef===item.id),metric=item.metric,block=el('fieldset','rp-form-item');block.append(el('legend','',item.name));
      if(!metric) {block.append(el('p','notice','先选择百分比或设置计数目标，再填写本事项；系统不会猜测口径。'),crmButton('设置进度口径',()=>rpMetricEditor(item),'quiet-button'));grid.append(block);continue;}
      const include=crmSelect([['false','不纳入当日草稿'],['true','保留 / 更正本事项']],old?'true':'false');block.append(labeled('当日事项',include));
      const text=crmText(old?.progressText||'',4000),type=crmSelect(detail.types.map(t=>[t,t]),old?.progressType||detail.types.at(-1));block.append(labeled('当日事实',text),labeled('类型',type));
      const value=crmInput(metric?.mode==='count'?(old?.completedCount??''):(old?.progressValue??''),'number');value.min='0';value.max=metric?.mode==='count'?String(metric.total):'100';
      block.append(labeled(metric?.mode==='count'?`累计完成数 / 总目标${metric.total}${metric.unit}`:'累计百分比（未知留空）',value));
      const added=crmText((old?.completedKeys||[]).join('\n'),12000),removed=crmText((old?.retractedKeys||[]).join('\n'),12000);
      if(metric?.mode==='count') {block.append(labeled('本日完成对象（每行一个稳定名称，与累计数二选一）',added),labeled('本日撤销完成对象（每行一个）',removed));}
      grid.append(block);controls.push({item,include,text,type,value,added,removed});
    }
    return()=>({date,summary:summary.value,expectedReportId:detail.currentReportId??null,items:controls.filter(c=>c.include.value==='true').map(c=>({workItemRef:c.item.id,progressText:c.text.value,progressType:c.type.value,
      ...(c.item.metric?.mode==='count'?{...(c.value.value===''?{}:{completedCount:Number(c.value.value)}),completedKeys:c.added.value.split('\n').map(x=>x.trim()).filter(Boolean),retractedKeys:c.removed.value.split('\n').map(x=>x.trim()).filter(Boolean),progressValue:null}:{progressValue:c.value.value===''?null:Number(c.value.value)})}))});
  },async body=>{const result=await fetchJson('/api/v1/reporting/daily',{method:'POST',headers:{'Idempotency-Key':requestId},body:JSON.stringify(body)});location.hash=`#/records/daily/${result.reportId}`;},'保存待确认草稿');
}
async function rpMetricEditor(item) {
  const data=await fetchJson(`/api/v1/reporting/metrics/${item.id}`),metric=data.metric;
  crmModal(`${item.name} · 进度口径`,'目标变化保留修订，并使已有周报标记为待重生成。不要用目标变更代替完成事实。',grid=>{
    const mode=crmField(grid,'计算方式',crmSelect([['percent','直接填写累计百分比'],['count','按完成数 / 总目标计算']],metric?.mode||'percent'));
    const total=crmField(grid,'总目标（计数时必填）',crmInput(metric?.total??'','number'));total.min='1';total.max='1000000';
    const unit=crmField(grid,'单位，如家 / 场 / 项（百分比填%）',crmInput(metric?.unit||'%','text',20));
    const rounding=crmField(grid,'百分比取整',crmSelect([['floor','整数截断（1/3=33%，2/3=66%）'],['round','四舍五入']],metric?.rounding||'floor'));
    return()=>({mode:mode.value,total:mode.value==='count'?Number(total.value):null,unit:unit.value,rounding:rounding.value,expectedVersion:metric?.version||0});
  },async body=>{await fetchJson(`/api/v1/reporting/metrics/${item.id}`,{method:'PUT',body:JSON.stringify(body)});await wsRefresh();},'保存进度口径');
}
function rpPlanActions(item,week) {
  const row=el('div','person-actions');row.append(crmButton('编辑',()=>wsPlanEditor(item,week),'quiet-button'),crmButton('目标口径',()=>rpMetricEditor(item),'quiet-button'));
  const createdWeekday=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Shanghai',weekday:'short'}).format(new Date(item.created_at));
  const mondayLock=createdWeekday==='Mon'&&crmDate()>week;
  if(week===wsMonday()&&!mondayLock) row.append(crmButton('移除',async()=>{if(!window.confirm('移除此事项？历史记录和修订仍会保留。'))return;try{await fetchJson(`/api/v1/workspace/items/${item.id}`,{method:'DELETE',body:JSON.stringify({version:item.version})});await wsRefresh();}catch(error){notify(error.message);}},'danger-button'));
  else if(mondayLock) row.append(el('small','muted','周一事项已锁定'));return row;
}
async function rpAnalytics() {
  const data=await fetchJson(`/api/v1/reporting/analytics?weekId=${WS_CONTEXT.weekId||wsMonday()}`),section=el('section','ws-detail');section.append(el('h3','section-title','完成率与本周趋势'),el('p','muted',data.rule));
  section.append(wsTable(['人员','排行','已知事项平均','每日轨迹（点击日期查看周报）','缺报'],data.rows.map(row=>{
    const trend=el('div','rp-trend');for(const point of row.trends){const link=wsLink('',rpUrl(row.userId,row.weekId),'rp-trend-point');link.setAttribute('aria-label',`${point.date} ${point.value==null?'未知':point.value+'%'}，查看来源`);const column=el('span','rp-trend-column'),bar=el('span',point.value==null?'rp-trend-unknown':'rp-trend-bar');bar.style.height=`${point.value??100}%`;column.append(bar);link.append(el('small','',point.value==null?'?':`${point.value}%`),column,el('small','',point.date.slice(5)));trend.append(link);}
    return[wsLink(row.name,rpUrl(row.userId,row.weekId)),row.rank??'数值未齐，不排名',rpMeter(row.average),trend,`${row.missingDays.length}天`];
  }),'暂无授权人员。'));app.append(section);
}
async function rpTypeSettings() {
  const data=await fetchJson('/api/v1/reporting/types'),form=el('form','ws-settings-form');
  const input=crmText(data.types.join('\n'),660);input.required=true;
  const save=el('button','secondary-button','保存进展类型');save.type='submit';const status=el('span','form-status');
  form.append(el('h3','section-title','日报进展类型'),el('p','muted','每行一个类型，最多20项；新草稿使用新配置，历史记录不被改写。'),labeled('可选类型',input),save,status);
  form.addEventListener('submit',async event=>{event.preventDefault();save.disabled=true;try{await fetchJson('/api/v1/reporting/types',{method:'PUT',body:JSON.stringify({types:input.value.split('\n').map(t=>t.trim()).filter(Boolean)})});status.textContent='已保存';}catch(error){status.textContent=error.message;}finally{save.disabled=false;}});app.append(form);
}
function rpScopedFeedback(report,previous) {
  const requestId=rpRequestId();
  crmModal(previous?'修订该版本反馈':'新增该版本反馈',`${report.weekId} · 周报 v${report.version}；保存后进入通知队列，旧反馈修订仍保留。`,grid=>{
    const input=crmField(grid,'反馈内容',crmText(previous?.content||'',10000),true);input.required=true;
    return()=>({reportId:report.id,content:input.value,...(previous?{feedbackId:previous.id,expectedVersion:previous.revision||1}:{})});
  },async body=>{await fetchJson(`/api/v1/reports/${encodeURIComponent(report.userId)}/${report.weekId}/feedback`,{method:previous?'PUT':'POST',headers:{'Idempotency-Key':requestId},body:JSON.stringify(body)});await wsRefresh();},'保存并通知');
}
