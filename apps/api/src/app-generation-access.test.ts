import { afterEach, describe, expect, it } from 'vitest';
import { MockAgent, type AgentTaskRequest } from '@wecom/agent';
import * as repo from '@wecom/persistence';
import { CrmStore } from '../../../packages/persistence/src/crm';
import { DailyAssistantApp } from './app';

const databases: repo.Db[] = [];
const at='2026-09-05T04:00:00Z', week='2026-08-31', date='2026-09-05';
type Mutation = 'inactive'|'disabled'|'unlinked'|'version'|'reassigned';
function setup() {
  const db=repo.openDb(':memory:');databases.push(db);
  repo.upsertUser(db,{id:'lead',name:'组长',role:'team_lead'});
  repo.upsertUser(db,{id:'staff',name:'员工',manager_user_id:'lead'});
  repo.upsertUser(db,{id:'admin',role:'admin'});repo.upsertUser(db,{id:'other'});
  repo.createKnowledgeEntry(db,{id:'knowledge',kind:'park_material',title:'园区资料',summary:'资料摘要',content:'测试知识正文',tags_json:'[]',source_name:'测试',created_at:at,updated_at:at});
  const crm=new CrmStore(db), company=crm.saveCompany({name:'企业',ownerId:'staff'},'admin');
  crm.link(company.id,{knowledgeId:'knowledge'},'admin');
  const mutate=(kind:Mutation) => {
    if(kind==='inactive') db.prepare("UPDATE app_user SET active=0 WHERE id='staff'").run();
    if(kind==='disabled') db.prepare("UPDATE knowledge_entry SET active=0 WHERE id='knowledge'").run();
    if(kind==='unlinked') db.prepare("DELETE FROM crm_knowledge_link WHERE knowledge_id='knowledge'").run();
    if(kind==='version') db.prepare("UPDATE knowledge_entry SET version=version+1,content='更新正文' WHERE id='knowledge'").run();
    if(kind==='reassigned') crm.saveCompany({ownerId:'other',version:1,reason:'测试转交'},'admin',company.id);
  };
  const control:{during?:(request:AgentTaskRequest)=>void;calls:number;dailySummary?:string}={calls:0};
  const mock=new MockAgent();
  const app=new DailyAssistantApp(db,{run:async request=>{
    control.calls++;
    const response=await mock.run(request);
    if(response.taskType==='daily_record_extract'&&control.dailySummary) response.result.summary=control.dailySummary;
    control.during?.(request);
    return response;
  }});
  return {db,app,control,mutate,crm,company};
}
afterEach(()=>databases.splice(0).forEach(db=>db.close()));

describe('生成及确认时的人员与知识依赖提交闸门',()=>{
  for(const mutation of ['inactive','disabled','unlinked','version','reassigned'] as const) {
    it(`日报生成期间${mutation}拒绝新草稿，原始消息留存failed且释放running`,async()=>{
      const {db,app,control,mutate}=setup();
      control.during=request=>{expect(request.context.knowledgeSnippets?.map(row=>row.id)).toEqual(['knowledge']);mutate(mutation);};
      await expect(app.submitRecord('staff',date,'今天核查材料',{messageId:'daily-race'})).rejects.toThrow(mutation==='inactive'?'停用':'权限或版本已变化');
      expect(db.prepare('SELECT COUNT(*) AS n FROM daily_report').get()?.n).toBe(0);
      expect(repo.getSourceMessageByMsgId(db,'daily-race')).toMatchObject({text_content:'今天核查材料',process_status:'agent_failed',daily_report_id:null});
      expect(repo.getDailyGeneration(db,'poc','staff',date)?.status).toBe('failed');
      expect(db.prepare('SELECT COUNT(*) AS n FROM generated_report_knowledge').get()?.n).toBe(0);
    });
    it(`周报生成期间${mutation}拒绝发布和出队任务，释放租约`,async()=>{
      const {db,app,control,mutate}=setup();
      control.during=()=>mutate(mutation);
      await expect(app.generateWeeklyReport('staff',week,{notifyManager:true})).rejects.toThrow(mutation==='inactive'?'停用':'权限或版本已变化');
      expect(db.prepare('SELECT COUNT(*) AS n FROM weekly_report').get()?.n).toBe(0);
      expect(db.prepare('SELECT COUNT(*) AS n FROM message_outbox').get()?.n).toBe(0);
      expect(db.prepare('SELECT lease_token,generation_fingerprint FROM weekly_instance').get()).toMatchObject({lease_token:null,generation_fingerprint:null});
      expect(db.prepare('SELECT COUNT(*) AS n FROM generated_report_knowledge').get()?.n).toBe(0);
    });
  }
  it('停用人员在开始阶段拒绝，不启动模型或新生成租约',async()=>{
    const {db,app,control,mutate}=setup();mutate('inactive');
    await expect(app.submitRecord('staff',date,'不应生成')).rejects.toThrow('停用');
    await expect(app.generateWeeklyReport('staff',week)).rejects.toThrow('停用');
    expect(control.calls).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM source_message').get()?.n).toBe(0);
  });
  for(const mutation of ['inactive','disabled','unlinked','version','reassigned'] as const) {
    it(`已生成待确认日报在${mutation}后拒绝展示回执和确认，不能借已展示快照越过撤权`,async()=>{
      const {db,app,mutate}=setup();
      const id=await app.submitRecord('staff',date,'原始事实');
      const row=repo.getDailyReportById(db,id)!;
      const presentation=app.prepareDailyPresentation('staff',id);
      app.completeDailyPresentation('staff',presentation);
      const inFlight=app.prepareDailyPresentation('staff',id);
      const before=JSON.stringify(row);mutate(mutation);
      expect(()=>app.dailyPreview(row)).toThrow();
      expect(()=>app.prepareDailyPresentation('staff',id)).toThrow();
      expect(()=>app.completeDailyPresentation('staff',inFlight)).toThrow();
      expect(()=>app.confirmReport('staff',id,'button')).toThrow();
      expect(JSON.stringify(repo.getDailyReportById(db,id))).toBe(before);
      expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='daily_report.confirmed'").get()?.n).toBe(0);
    });
  }
  it('知识重新授权后原始失败消息可重试，不被running锁住；仅存id/version，不复制正文到依赖表',async()=>{
    const {db,app,control,mutate,crm,company}=setup();
    control.during=()=>mutate('unlinked');
    await expect(app.submitRecord('staff',date,'可重试原文',{messageId:'retry'})).rejects.toThrow('权限或版本已变化');
    control.during=undefined;crm.link(company.id,{knowledgeId:'knowledge'},'admin');
    const id=await app.submitRecord('staff',date,'可重试原文',{messageId:'retry'});
    expect(repo.getDailyGeneration(db,'poc','staff',date)?.status).toBe('completed');
    expect(repo.getSourceMessageByMsgId(db,'retry')?.daily_report_id).toBe(id);
    expect(db.prepare('SELECT dependencies_json FROM generated_report_knowledge WHERE report_id=?').get(id)?.dependencies_json).toBe('[{"id":"knowledge","version":1}]');
  });
  it('周报新版本生成失败不破坏已发布历史；重新读取依赖守门可拒绝展示但不改旧正文',async()=>{
    const {db,app,control,mutate}=setup();
    const id=await app.generateWeeklyReport('staff',week), before=repo.getWeeklyReportById(db,id)!;
    control.during=()=>mutate('version');
    await expect(app.generateWeeklyReport('staff',week)).rejects.toThrow('权限或版本已变化');
    expect(repo.getWeeklyReportById(db,id)).toEqual(before);
    expect(()=>app.assertReportKnowledge('staff',id,'weekly')).toThrow('权限或版本已变化');
    expect(db.prepare('SELECT COUNT(*) AS n FROM weekly_report').get()?.n).toBe(1);
  });
  it('生成完成事务失败也释放日报状态并保留原文，不误判成功',async()=>{
    const {db,app}=setup();
    db.exec("CREATE TRIGGER reject_dep BEFORE INSERT ON generated_report_knowledge BEGIN SELECT RAISE(ABORT,'dependency write failed'); END");
    await expect(app.submitRecord('staff',date,'应保留原文',{messageId:'db-failure'})).rejects.toThrow('dependency write failed');
    expect(repo.getDailyGeneration(db,'poc','staff',date)?.status).toBe('failed');
    expect(repo.getSourceMessageByMsgId(db,'db-failure')).toMatchObject({process_status:'agent_failed',text_content:'应保留原文'});
    expect(db.prepare('SELECT COUNT(*) AS n FROM daily_report').get()?.n).toBe(0);
  });
  it('已确认日报所用知识撤权后不能通过日报摘要再次进入周报模型',async()=>{
    const {db,app,control,mutate}=setup();
    const daily=await app.submitRecord('staff',date,'已确认工作事实');
    app.completeDailyPresentation('staff',app.prepareDailyPresentation('staff',daily));app.confirmReport('staff',daily,'button');
    const calls=control.calls;mutate('unlinked');
    await expect(app.generateWeeklyReport('staff',week)).rejects.toThrow('权限或版本已变化');
    expect(control.calls).toBe(calls);
    expect(repo.getDailyReportById(db,daily)?.status).toBe('confirmed');
    expect(db.prepare('SELECT COUNT(*) AS n FROM weekly_report').get()?.n).toBe(0);
    expect(db.prepare('SELECT lease_token FROM weekly_instance').get()?.lease_token).toBeNull();
  });
  it('周报继承日报间接知识依赖，即便本次未重新检索；await期间撤权仍拒绝发布',async()=>{
    const {db,app,control,mutate}=setup();
    // service_company knowledge is retrieved by title/tag only, unlike the generic-material baseline.
    db.prepare("UPDATE knowledge_entry SET kind='service_company' WHERE id='knowledge'").run();
    control.dailySummary='核查材料';
    const daily=await app.submitRecord('staff',date,'园区资料：核查了材料');
    // Keep the test summary factual but omit the retrieval title, reproducing an
    // indirect dependency that a subsequent title matcher would not select.
    app.completeDailyPresentation('staff',app.prepareDailyPresentation('staff',daily));app.confirmReport('staff',daily,'button');
    const weekly=await app.generateWeeklyReport('staff',week);
    expect(db.prepare('SELECT dependencies_json FROM generated_report_knowledge WHERE report_id=?').get(weekly)?.dependencies_json).toBe('[{"id":"knowledge","version":1}]');
    control.during=request=>{expect(request.context.knowledgeSnippets).toEqual([]);mutate('unlinked');};
    await expect(app.generateWeeklyReport('staff',week)).rejects.toThrow('权限或版本已变化');
    expect(db.prepare('SELECT COUNT(*) AS n FROM weekly_report').get()?.n).toBe(1);
    expect(()=>app.assertReportKnowledge('staff',weekly,'weekly')).toThrow('权限或版本已变化');
  });
});
