import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as repo from '@wecom/persistence';
import { MockAgent, type Agent } from '@wecom/agent';
import { startServer } from './server';
import { DailyAssistantApp } from './app';
import { verifyStructuredArchive } from './archive';
import { setItemMetric } from './progress-ledger';

const fixtures:Array<{db:repo.Db;server:Awaited<ReturnType<typeof startServer>>;dir:string}>=[];
const week='2026-08-31', date='2026-09-04';
beforeEach(()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-09-05T04:00:00Z'));});
afterEach(async()=>{for(const f of fixtures.splice(0)){f.db.close();await new Promise<void>(resolve=>f.server.close(()=>resolve()));rmSync(f.dir,{recursive:true,force:true});}vi.useRealTimers();});
async function setup(agent:Agent=new MockAgent()) {
  const dir=mkdtempSync(join(tmpdir(),'reporting-http-')),dbPath=join(dir,'test.sqlite');
  const server=await startServer({host:'127.0.0.1',port:0,dbPath,accessCode:'isolated-reporting-test',agent});
  const db=repo.openDb(dbPath),app=new DailyAssistantApp(db,agent);fixtures.push({dir,db,server});
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request=async(path:string,token:string|null,method='GET',body?:unknown,key?:string)=>{
    const response=await fetch(`${base}/api/v1${path}`,{method,headers:{...(token?{authorization:`Bearer ${token}`} :{}),...(body===undefined?{}:{'content-type':'application/json'}),...(key?{'Idempotency-Key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json() as Record<string,any>};
  };
  const admin=(await request('/auth/login',null,'POST',{accessCode:'isolated-reporting-test'})).body.token as string;
  repo.upsertUser(db,{id:'m',name:'主管',role:'team_lead'});
  repo.upsertUser(db,{id:'e',name:'员工甲',role:'employee',manager_user_id:'m'});
  repo.upsertUser(db,{id:'x',name:'外组员工',role:'employee'});
  const token=(userId:string,resourceId?:string)=>{
    const value=randomUUID(),user=repo.getUser(db,userId)!;
    repo.insertAuthSession(db,{token_hash:createHash('sha256').update(value).digest('hex'),user_id:userId,role:user.role,resource_id:resourceId??null,created_at:new Date().toISOString(),expires_at:new Date(Date.now()+60_000).toISOString()});return value;
  };
  app.createWeeklyPlan('e',week,[{name:'合同梳理',planBackground:'三项合同'}]);
  const item=repo.listWorkItems(db,'e',week)[0],employee=token('e'),manager=token('m');
  setItemMetric(db,{userId:'e',role:'employee'},item.id,{mode:'percent',unit:'%',rounding:'floor',expectedVersion:0});
  const facts=(value:number|null,expectedReportId:string|null=null)=>({date,summary:'合同梳理情况',expectedReportId,items:[{workItemRef:item.id,progressText:'已核实合同进展',progressType:'其他',progressValue:value}]});
  const confirm=(id:string)=>{app.completeDailyPresentation('e',app.prepareDailyPresentation('e',id));return app.confirmReport('e',id,'button');};
  return {db,app,request,admin,employee,manager,item,facts,confirm,token};
}

describe('结构化填报到周报的 HTTP 闭环',()=>{
  it('环比返回上周同一截止日，保持人员权限，缺少数据不会伪造上周进度',async()=>{
    const s=await setup();
    const response=await s.request(`/reporting/weeks?weekId=${week}&view=team`,s.manager);
    expect(response.status).toBe(200);
    const employee=response.body.rows.find((row:any)=>row.userId==='e');
    expect(employee.previousWeek).toBe('2026-08-24');
    expect(employee.previousAsOf).toBe('2026-08-29');
    expect(employee.previousProgress.items).toEqual([]);
    expect(response.body.rows.some((row:any)=>row.userId==='x')).toBe(false);
  });
  it('必须登录，员工/团队/报告限定会话隔离，并拒绝越权事项',async()=>{
    const s=await setup();
    expect((await s.request('/reporting/weeks',null)).status).toBe(401);
    expect((await s.request('/reporting/weeks?view=team',s.employee)).status).toBe(403);
    expect((await s.request('/reporting/weeks?view=team&userId=x',s.manager)).status).toBe(404);
    expect((await s.request('/reporting/weeks',s.token('m','single-report'))).status).toBe(403);
    expect((await s.request(`/reporting/metrics/${s.item.id}?view=team`,s.manager,'PUT',{mode:'percent',unit:'%',expectedVersion:0})).status).toBe(403);
    expect((await s.request('/reporting/types',s.employee,'PUT',{types:['访企']})).status).toBe(403);
    expect((await s.request('/reporting/weeks?weekId=2026-09-01',s.employee)).status).toBe(400);
    expect((await s.request('/reporting/weeks?companyId=unseen',s.employee)).status).toBe(404);
  });
  it('表单事实不调用模型且只生成草稿；未完整展示不可确认，数值/对象会完整展示',async()=>{
    const run=vi.fn(async()=>{throw new Error('结构化表单不可调用LLM');}),s=await setup({run});
    expect((await s.request(`/reporting/metrics/${s.item.id}`,s.employee,'PUT',{mode:'count',total:3,unit:'项',rounding:'floor',expectedVersion:1})).status).toBe(200);
    const body=s.facts(null);Object.assign(body.items[0],{completedKeys:['合同A','合同B']});
    const result=await s.request('/reporting/daily',s.employee,'POST',body,'form-1');expect(result.status).toBe(201);expect(run).not.toHaveBeenCalled();
    const report=repo.getDailyReportById(s.db,result.body.reportId)!;expect(report.status).toBe('pending_confirmation');
    expect(()=>s.app.confirmReport('e',report.id,'button')).toThrow('完整展示');
    expect(s.app.dailyPreview(report)).toContain('合同A、合同B');s.confirm(report.id);
    const detail=await s.request(`/reporting/weeks/e/${week}`,s.employee);expect(detail.body.progress.items[0].days[4]).toMatchObject({progressValue:66,completedCount:2});
  });
  it('重投幂等、陈旧稿409、非法日期/类型/越权字段拒绝；新草稿不挤掉旧确认',async()=>{
    const s=await setup(),body=s.facts(33);
    expect((await s.request('/reporting/daily',s.employee,'POST',body)).status).toBe(400);
    const first=await s.request('/reporting/daily',s.employee,'POST',body,'form-2');expect(first.status).toBe(201);s.confirm(first.body.reportId);
    expect((await s.request('/reporting/daily',s.employee,'POST',body,'form-2')).body.reportId).toBe(first.body.reportId);
    expect((await s.request('/reporting/daily',s.employee,'POST',s.facts(66),'form-2')).status).toBe(409);
    expect((await s.request('/reporting/daily',s.employee,'POST',s.facts(66),'form-3')).status).toBe(409);
    for(const delta of [{date:'2026-09-06'},{date:'2026-08-30'},{date:'2026-02-30'},{userId:'x'},{tenantId:'other'}]) expect((await s.request('/reporting/daily',s.employee,'POST',{...body,...delta},randomUUID())).status).toBe(400);
    const next=s.facts(66,first.body.reportId);const draft=await s.request('/reporting/daily',s.employee,'POST',next,'form-4');expect(draft.status).toBe(201);
    let detail=await s.request(`/reporting/weeks/e/${week}`,s.employee);expect(detail.body.progress.items[0].days[4].progressValue).toBe(33);
    s.confirm(draft.body.reportId);detail=await s.request(`/reporting/weeks/e/${week}`,s.employee);expect(detail.body.progress.items[0].days[4].progressValue).toBe(66);
    expect(repo.getDailyReportById(s.db,first.body.reportId)?.status).toBe('superseded');
  });
  it('稳定入口保留版本；原因修订令旧报告过期，反馈仅原管理者修改且外发幂等',async()=>{
    const s=await setup(),draft=await s.request('/reporting/daily',s.employee,'POST',s.facts(33),'weekly-facts');s.confirm(draft.body.reportId);
    const first=await s.request(`/reporting/weeks/e/${week}/generate`,s.employee,'POST',{});expect(first.status).toBe(201);
    const before=await s.request(`/reporting/weeks/e/${week}`,s.employee);expect(before.body.detail.instance.stale).toBe(false);
    expect((await s.request(`/reporting/weeks/e/${week}/reason`,s.employee,'PUT',{content:'合同存在变更，下周继续',expectedVersion:0})).status).toBe(200);
    expect((await s.request(`/reporting/weeks/e/${week}`,s.employee)).body.detail.instance.stale).toBe(true);
    const second=await s.request(`/reporting/weeks/e/${week}/generate?view=team`,s.manager,'POST',{});expect(second.status).toBe(201);
    const after=await s.request(`/reporting/weeks/e/${week}`,s.employee);expect(after.body.detail.instance.id).toBe(before.body.detail.instance.id);expect(after.body.detail.history).toHaveLength(2);
    const feedback={weeklyReportId:first.body.reportId,content:'请确认合同条款'};
    const f=await s.request('/reporting/feedback?view=team',s.manager,'POST',feedback,'feedback-1');expect(f.status).toBe(201);
    expect((await s.request('/reporting/feedback?view=team',s.manager,'POST',feedback,'feedback-1')).body.id).toBe(f.body.id);
    expect((await s.request(`/reporting/feedback/${f.body.id}?view=team`,s.manager,'PUT',{...feedback,content:'请重点核对变更条款',expectedVersion:1},'feedback-2')).status).toBe(200);
    expect((await s.request(`/reporting/feedback/${f.body.id}?view=team`,s.admin,'PUT',{...feedback,expectedVersion:2},'feedback-other')).status).toBe(403);
    const historical=await s.request(`/workspace/weekly-reports/${first.body.reportId}`,s.employee);expect(historical.body.report.version).toBe(1);expect(historical.body.feedback[0]).toMatchObject({revision:2,revisions:[{content:'请确认合同条款'}]});
    expect(historical.body.sourceSnapshot.reasons).toHaveLength(0);
    expect(s.db.prepare("SELECT COUNT(*) n FROM message_outbox WHERE kind='manager_feedback'").get()?.n).toBe(2);
    const archive=await s.request('/admin/exports',s.admin,'POST',{year:2026,quarter:3,userId:'e'});expect(archive.status).toBe(200);expect(verifyStructuredArchive(archive.body)).toBe(true);expect(archive.body.weeklyReports).toHaveLength(2);expect(archive.body.feedbackRevisions).toHaveLength(2);
  });
  it('零日报仍列出，未知不当0、不排名；已知0与33均可参与排行',async()=>{
    const s=await setup();
    let data=await s.request(`/reporting/analytics?view=team&weekId=${week}`,s.manager);expect(data.body.rows.map((r:any)=>r.userId).sort()).toEqual(['e','m']);expect(data.body.rows.every((r:any)=>r.rank===null)).toBe(true);
    const draft=await s.request('/reporting/daily',s.employee,'POST',s.facts(0),'zero');s.confirm(draft.body.reportId);
    data=await s.request(`/reporting/analytics?view=team&weekId=${week}`,s.manager);expect(data.body.rows.find((r:any)=>r.userId==='e')).toMatchObject({rank:1,average:0,eligible:true});expect(data.body.rows.find((r:any)=>r.userId==='m')).toMatchObject({rank:null,average:null});
    expect(data.body.rows[0].missingDays).not.toContain('2026-09-05');
  });
  it('后台生成走注入Agent，模板漏必填时不发布且可立即重试',async()=>{
    let omit=true;const mock=new MockAgent(),run=vi.fn(async(request:Parameters<Agent['run']>[0])=>{
      const response=await mock.run(request);if(request.taskType==='weekly_report_generate'&&response.taskType==='weekly_report_generate'&&omit)response.result.sections=[];return response;
    });
    const s=await setup({run});
    repo.createTemplateVersion(s.db,{id:'required-week',kind:'weekly',name:'必填周报',content:JSON.stringify({sections:[{title:'本周工作',required:true}]}),created_at:new Date().toISOString()});
    const first=await s.request(`/reporting/weeks/e/${week}/generate`,s.employee,'POST',{});expect(first.status).toBe(400);expect(first.body.error).toContain('必填');expect(repo.getWeeklyReport(s.db,'e',week)).toBeUndefined();
    omit=false;expect((await s.request(`/reporting/weeks/e/${week}/generate`,s.employee,'POST',{})).status).toBe(201);expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0][0].idempotencyKey).not.toBe(run.mock.calls[1][0].idempotencyKey);
  });
  it.each(['role','scope'])('模型等待期间发起者%s变化，不能发布或排队通知',async change=>{
    let db:repo.Db;const mock=new MockAgent();
    const s=await setup({run:async request=>{
      if(change==='role') db.prepare("UPDATE app_user SET role='employee' WHERE id='m'").run();
      else db.prepare("UPDATE app_user SET manager_user_id=NULL WHERE id='e'").run();
      return mock.run(request);
    }});db=s.db;
    const result=await s.request(`/reporting/weeks/e/${week}/generate?view=team`,s.manager,'POST',{});
    expect(result.status).toBe(403);expect(repo.getWeeklyReport(db,'e',week)).toBeUndefined();expect(db.prepare('SELECT COUNT(*) n FROM message_outbox').get()?.n).toBe(0);
  });
  it('手动重生成和通知同事务提交，通知以发布版本去重，插入失败不留下半成品',async()=>{
    const s=await setup(),first=await s.request(`/reporting/weeks/e/${week}/generate`,s.employee,'POST',{});expect(first.status).toBe(201);
    expect(s.db.prepare("SELECT dedupe_key FROM message_outbox WHERE kind='weekly_report'").all()).toEqual([{dedupe_key:`weekly-report:m:${first.body.reportId}`}]);
    s.db.exec("CREATE TRIGGER stop_notify BEFORE INSERT ON message_outbox BEGIN SELECT RAISE(ABORT,'test enqueue failure'); END;");
    const next=await s.request(`/reporting/weeks/e/${week}/generate`,s.employee,'POST',{});expect(next.status).toBe(400);
    expect(s.db.prepare('SELECT COUNT(*) n FROM weekly_report').get()?.n).toBe(1);expect(repo.getWeeklyReport(s.db,'e',week)?.id).toBe(first.body.reportId);
  });
  it('企微专属周报入口含冻结七日进度与反馈修订，只能操作授权的那个版本',async()=>{
    const s=await setup(),first=await s.request(`/reporting/weeks/e/${week}/generate`,s.employee,'POST',{});
    const second=await s.request(`/reporting/weeks/e/${week}/generate`,s.employee,'POST',{}),scoped=s.token('m',first.body.reportId);
    const report=await s.request(`/reports/e/${week}`,scoped);expect(report.body).toMatchObject({id:first.body.reportId,version:1,progressSnapshot:{dates:expect.any(Array)}});expect(report.body.progressSnapshot.dates).toHaveLength(7);
    const initial={reportId:first.body.reportId,content:'针对旧发布版本反馈'};
    const feedback=await s.request(`/reports/e/${week}/feedback`,scoped,'POST',initial,'scoped-one');expect(feedback.status).toBe(201);
    expect((await s.request(`/reports/e/${week}/feedback`,scoped,'POST',initial,'scoped-one')).body.id).toBe(feedback.body.id);
    expect((await s.request(`/reports/e/${week}/feedback`,scoped,'PUT',{...initial,feedbackId:feedback.body.id,expectedVersion:1,content:'修订旧版本反馈'},'scoped-two')).status).toBe(200);
    expect((await s.request(`/reports/e/${week}`,scoped)).body.feedback[0]).toMatchObject({revision:2,revisions:[{content:'针对旧发布版本反馈'}]});
    expect((await s.request(`/reports/e/${week}/feedback`,scoped,'POST',{...initial,reportId:second.body.reportId},'wrong-report')).status).toBe(403);
    expect((await s.request(`/reports/x/${week}`,scoped)).status).toBe(403);
    expect((await s.request(`/reporting/weeks/e/${week}`,scoped)).status).toBe(403);
  });
});
