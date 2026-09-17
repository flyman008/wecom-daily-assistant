import { afterEach, expect, it } from 'vitest';
import { MockAgent, type DailyExtractResult } from '@wecom/agent';
import * as repo from '@wecom/persistence';
import { CrmStore } from '../../../packages/persistence/src/crm';
import { matchDailyCompanies } from './daily-companies';
import { DailyAssistantApp } from './app';

const dbs: repo.Db[]=[];
afterEach(()=>dbs.splice(0).forEach(db=>db.close()));
function setup() {
  const db=repo.openDb(':memory:');dbs.push(db);
  repo.upsertUser(db,{id:'employee',name:'员工'});repo.upsertUser(db,{id:'other',name:'其他员工'});
  const store=new CrmStore(db), company=store.saveCompany({name:'测试甲科技有限公司',aliases:['测试甲'],ownerId:'employee'},'employee');
  store.saveCompany({name:'测试乙有限公司',ownerId:'other'},'other');
  const result:DailyExtractResult={schemaVersion:1,summary:'测试',items:[{workItemRef:'visit',progressText:'今天走访测试甲科技有限公司',progressType:'走访',progressValue:null,issues:[],nextActions:[],sourceRecordRefs:['s']}],missingFields:[],riskFlags:[]};
  return {db,company,result};
}
it('原文和事项均有企业全称才关联；支持唯一已配置简称',()=>{
  const {db,company,result}=setup();
  for(const text of ['今天走访测试甲科技有限公司','今天走访测试甲']) {
    result.items[0].progressText=text;
    const matched=matchDailyCompanies(db,'employee',result,[{id:'s',text,date:'2026-08-31'}]);
    expect(matched.items[0].companyRefs).toEqual([{id:company.id,name:'测试甲科技有限公司'}]);
  }
});
it('模型杜撰、越权企业、未登记名称不关联也不新增企业',()=>{
  const {db,result}=setup();
  for(const [text,summary] of [['今天走访一家企业','今天走访测试甲科技有限公司'],['走访测试乙有限公司','走访测试乙有限公司'],['走访未知公司','走访未知公司']]) {
    result.items[0].progressText=summary;
    const matched=matchDailyCompanies(db,'employee',result,[{id:'s',text,date:'2026-08-31'}]);
    expect(matched.items[0].companyRefs).toEqual([]);expect(matched.missingFields.join('')).toContain('企业全称');
  }
  expect(new CrmStore(db).companies()).toHaveLength(2);
});
it('日报确认前不写企业关联，确认后关联且重复确认不重复写入',async()=>{
  const {db,company,result}=setup(),app=new DailyAssistantApp(db,new MockAgent());
  app.createWeeklyPlan('employee','2026-08-31',[{name:'走访',planBackground:''}]);
  result.items[0].workItemRef=repo.listWorkItems(db,'employee','2026-08-31')[0].id;
  const id=await app.submitRecord('employee','2026-08-31','今天走访测试甲科技有限公司',{structuredResult:result,messageId:'match-test'});
  const count=()=>db.prepare("SELECT COUNT(*) AS n FROM crm_event WHERE kind='daily_report_linked'").get()!.n;
  const draft=repo.getDailyReportById(db,id)!;
  expect(count()).toBe(0);
  expect(app.dailyPreview(draft)).toContain('今天走访测试甲科技有限公司');
  expect(JSON.parse(draft.progress_json!)[0].companyRefs).toEqual([{id:company.id,name:company.name}]);
  app.completeDailyPresentation('employee',app.prepareDailyPresentation('employee',id));
  app.confirmReport('employee',id,'button');app.confirmReport('employee',id,'button');
  expect(count()).toBe(1);
  expect(db.prepare("SELECT company_id FROM crm_event WHERE kind='daily_report_linked'").get()!.company_id).toBe(company.id);
});
it('学习政策和整理企业常见问题不强制关联企业，但真实走访仍追问',()=>{
  const {db,result}=setup();
  result.items[0].progressText='完成招商政策学习，整理企业常问问题';
  expect(matchDailyCompanies(db,'employee',result,[{id:'s',text:result.items[0].progressText,date:'2026-08-31'}]).missingFields).toEqual([]);
  result.items[0].progressText='今天走访一家企业，了解扩租需求';
  expect(matchDailyCompanies(db,'employee',result,[{id:'s',text:result.items[0].progressText,date:'2026-08-31'}]).missingFields.join('')).toContain('企业全称');
});
