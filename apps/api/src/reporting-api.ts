import { randomUUID } from 'node:crypto';
import * as repo from '@wecom/persistence';
import { weekId } from '@wecom/domain';
import type { DailyAssistantApp } from './app';
import { workspaceContext } from './workspace-api';
import { CrmError, CrmStore } from '../../../packages/persistence/src/crm';
import { visibleCompanies } from './crm-api';
import { buildWeeklyProgress, getItemMetric, setItemMetric } from './progress-ledger';
import { captureWeeklySources, getWeeklyDetail, getWeeklyInstance, saveWeeklyReason, saveWeeklyFeedback } from './weekly-workflow';
import { dailyQuality, progressTypes, submitStructuredDaily } from './daily-input';

function validWeek(value: string): string {
  const instant = new Date(`${value}T04:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(instant.getTime()) || instant.toISOString().slice(0,10)!==value || weekId(instant)!==value) throw new CrmError('请选择真实的周一日期');
  return value;
}
function today() { return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()); }
export async function reportingRequest(db: repo.Db, app: DailyAssistantApp, actor: repo.AccessActor, url: URL, method: string, body: Record<string,unknown>, requestId = '') {
  const context = workspaceContext(db,actor,url.searchParams.get('view'));
  const suffix = url.pathname.slice('/api/v1/reporting'.length), tenant = actor.tenantId ?? 'poc';
  const allowed = context.access.userIds;
  const read = (userId: string) => { if(!allowed.includes(userId)) throw new CrmError('记录不存在或无权访问',404); };
  const own = (userId: string) => { if(userId!==actor.userId || !repo.activeUser(db,userId,tenant)) throw new CrmError('只能填写本人内容',403); };
  const selectedWeek = validWeek(url.searchParams.get('weekId') ?? weekId(new Date()));
  if (suffix === '/types' && method === 'GET') return {status:200,body:{types:progressTypes(db,tenant)}};
  if (suffix === '/types' && method === 'PUT') {
    if(actor.role!=='admin') throw new CrmError('仅管理员可配置进展类型',403);
    const types=body.types;
    if(Object.keys(body).some(key=>key!=='types') || !Array.isArray(types) || !types.length || types.length>20 || types.some(x=>typeof x!=='string'||!x.trim()||x.length>32) || new Set(types.map(x=>String(x).trim())).size!==types.length) throw new CrmError('请填写1至20个不重复的类型，每项不超过32字');
    repo.inTransaction(db,()=>{repo.setConfig(db,'progressTypes',types.map(x=>String(x).trim()),tenant);repo.insertAudit(db,{id:randomUUID(),tenant_id:tenant,actor_user_id:actor.userId,action:'progress.types_updated',resource_type:'config',resource_id:'progressTypes',created_at:new Date().toISOString()});});
    return {status:200,body:{types:progressTypes(db,tenant)}};
  }
  const metric = suffix.match(/^\/metrics\/([^/]+)$/);
  if(metric) {
    const item=repo.getWorkItem(db,decodeURIComponent(metric[1]),tenant);
    if(!item) throw new CrmError('事项不存在',404);read(item.user_id);
    if(method==='GET') return {status:200,body:{metric:getItemMetric(db,item.id,tenant)??null}};
    if(method==='PUT') {own(item.user_id);return {status:200,body:{metric:setItemMetric(db,actor,item.id,body as unknown as Parameters<typeof setItemMetric>[3])}};}
  }
  if(suffix==='/daily' && method==='POST') return {status:201,body:{reportId:await submitStructuredDaily(app,actor,body,requestId)}};
  const daily = suffix.match(/^\/daily\/([^/]+)$/);
  if(daily && method==='GET') {
    const report=repo.getDailyReportById(db,decodeURIComponent(daily[1]),tenant);
    if(!report) throw new CrmError('日报不存在',404);read(report.user_id);
    if(!repo.isGeneratedReportReadable(db,report.user_id,report.id,'daily',tenant)) throw new CrmError('引用资料权限或版本已变化，请重新整理',403);
    return {status:200,body:{...dailyQuality(db,report.id,tenant), report,
      canEdit:report.user_id===actor.userId&&weekId(new Date(`${report.report_date}T04:00:00Z`))===weekId(new Date()),
      currentReportId:repo.getLatestDailyReport(db,report.user_id,report.report_date,tenant)?.id,
      items:repo.listWorkItems(db,report.user_id,weekId(new Date(`${report.report_date}T04:00:00Z`)),tenant).map(item=>({...item,metric:getItemMetric(db,item.id,tenant)??null})),types:progressTypes(db,tenant)}};
  }
  const weekMatch=suffix.match(/^\/weeks\/([^/]+)\/(\d{4}-\d{2}-\d{2})(?:\/(generate|reason))?$/);
  if(weekMatch) {
    const userId=decodeURIComponent(weekMatch[1]), week=validWeek(weekMatch[2]); read(userId);
    if(weekMatch[3]==='generate' && method==='POST') {
      if(userId!==actor.userId&&!context.access.canManage) throw new CrmError('无权生成该人员周报',403);
      if(week>weekId(new Date())) throw new CrmError('不能生成未来周报');
      const authorizeCommit=()=>{
        const current=repo.activeUser(db,actor.userId,tenant);
        const bootstrap=actor.userId==='poc-admin'&&actor.role==='admin'&&!repo.getUser(db,actor.userId,tenant);
        if(!bootstrap&&(!current||current.role!==actor.role)) throw new CrmError('生成期间身份已变化，结果未发布',403);
        const fresh=workspaceContext(db,actor,url.searchParams.get('view'));
        if(!fresh.access.userIds.includes(userId)||(userId!==actor.userId&&!fresh.access.canManage)) throw new CrmError('生成期间管理范围已变化，结果未发布',403);
      };
      return {status:201,body:{reportId:await app.generateWeeklyReport(userId,week,{authorizeCommit,notifyManager:true})}};
    }
    if(weekMatch[3]==='reason'&&method==='PUT') {own(userId);return {status:200,body:{reason:saveWeeklyReason(db,actor,{userId,weekId:week,workItemId:body.workItemId as string|null|undefined,content:body.content as string,expectedVersion:body.expectedVersion as number})}};}
    if(!weekMatch[3]&&method==='GET') {
      const detail=getWeeklyDetail(db,actor,userId,week,{history:true});
      if(detail.currentReport&&!repo.isGeneratedReportReadable(db,userId,detail.currentReport.id,'weekly',tenant)) throw new CrmError('引用资料权限或版本已变化，请重新生成；历史原文仍归档保留',403);
      detail.history=detail.history?.map(report=>repo.isGeneratedReportReadable(db,userId,report.id,'weekly',tenant)?report:{...report,content:'资料权限已变化',sections_json:'[]',item_snapshot_json:'[]'});
      return {status:200,body:{detail,
      progress:buildWeeklyProgress(db,userId,week,tenant),name:repo.getUser(db,userId,tenant)?.name,
      canEditReason:userId===actor.userId,canGenerate:userId===actor.userId||context.access.canManage,
      canFeedback:context.access.canManage&&userId!==actor.userId}};
    }
  }
  const feedback=suffix.match(/^\/feedback(?:\/([^/]+))?$/);
  if(feedback&&['POST','PUT'].includes(method)) {
    if(!context.access.canManage) throw new CrmError('请在管理视图填写反馈',403);
    if(!requestId.trim()||requestId.length>200) throw new CrmError('缺少请求标识');
    return {status:method==='POST'?201:200,body:saveWeeklyFeedback(db,actor,{weeklyReportId:body.weeklyReportId as string,content:body.content as string,
      idempotencyKey:requestId,
      ...(feedback[1]?{feedbackId:decodeURIComponent(feedback[1]),expectedVersion:body.expectedVersion as number}:{})})};
  }
  if((suffix==='/weeks'||suffix==='/analytics')&&method==='GET') {
    const selectedUser=url.searchParams.get('userId');if(selectedUser) read(selectedUser);
    const ids=selectedUser?[selectedUser]:allowed;
    const companyId=url.searchParams.get('companyId');
    if(companyId&&!visibleCompanies(new CrmStore(db),context.access).some(company=>company.id===companyId)) throw new CrmError('企业不存在或无权访问',404);
    const linked=companyId?new Set(db.prepare('SELECT source_report_id FROM crm_event WHERE tenant_id=? AND company_id=? AND source_report_id IS NOT NULL').all(tenant,companyId).map(row=>String(row.source_report_id))):null;
    const rows=ids.flatMap(userId=>{
      const user=repo.getUser(db,userId,tenant);if(!user?.active) return [];
      const instance=getWeeklyInstance(db,userId,selectedWeek,tenant), sources=captureWeeklySources(db,userId,selectedWeek,tenant);
      const report=repo.getWeeklyReport(db,userId,selectedWeek,tenant), progress=buildWeeklyProgress(db,userId,selectedWeek,tenant);
      if(linked&&!sources.confirmed.some(row=>linked.has(row.id))&&!(report&&JSON.parse(report.cited_report_ids_json).some((id:string)=>linked.has(id)))) return [];
      const dates=progress.dates.filter(date=>date<=today());
      const trends=dates.map(date=>{
        const points=progress.items.filter(item=>!item.retired).map(item=>item.days.find(day=>day.date===date)?.progressValue??null);
        const known=points.filter((value):value is number=>value!==null);
        return {date,value:known.length?Math.floor(known.reduce((a,b)=>a+b,0)/known.length):null,known:known.length,total:points.length};
      });
      const last=trends.at(-1), eligible=Boolean(last&&last.total>0&&last.known===last.total);
      const readableReport=!report||repo.isGeneratedReportReadable(db,userId,report.id,'weekly',tenant);
      const previousWeek=new Date(Date.parse(`${selectedWeek}T04:00:00Z`)-7*86400000).toISOString().slice(0,10);
      const previousReport=repo.getWeeklyReport(db,userId,previousWeek,tenant);
      const previousSources=captureWeeklySources(db,userId,previousWeek,tenant);
      const previousReadable=readableReport&&(!previousReport||repo.isGeneratedReportReadable(db,userId,previousReport.id,'weekly',tenant))
        &&previousSources.confirmed.every(source=>repo.isGeneratedReportReadable(db,userId,source.id,'daily',tenant));
      const asOf=dates.at(-1);
      const previousAsOf=asOf?new Date(Date.parse(`${asOf}T04:00:00Z`)-7*86400000).toISOString().slice(0,10):null;
      return [{userId,name:user.name,weekId:selectedWeek,instance,report:report?(readableReport?report:{...report,content:'引用资料权限已变化',sections_json:'[]',item_snapshot_json:'[]'}):null,restricted:!readableReport,confirmedDays:new Set(sources.confirmed.map(row=>row.report_date)).size,
        previousWeek,previousAsOf,previousProgress:previousReadable?buildWeeklyProgress(db,userId,previousWeek,tenant):null,
        reasons:readableReport?sources.reasons:[],progress,trends,average:last?.value??null,eligible,rank:null as number|null,missingDays:dates.filter(date=>date<today()&&!sources.confirmed.some(row=>row.report_date===date))}];
    });
    const ranked=rows.filter(row=>row.eligible).sort((a,b)=>(b.average??0)-(a.average??0)||a.name.localeCompare(b.name));
    ranked.forEach((row,index)=>{row.rank=index>0&&row.average===ranked[index-1].average?ranked[index-1].rank:index+1;});
    return {status:200,body:{weekId:selectedWeek,rows,rule:'仅按已确认记录计算；事项等权平均，未知不当0。全部有效事项均有数值才参与排行，同分同名次。'}};
  }
  throw new CrmError('接口不存在',404);
}
