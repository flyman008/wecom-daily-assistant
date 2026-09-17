// 演示种子数据：3 个员工、不同填报完成度，供看板展示差异。
import { MockAgent } from '@wecom/agent';
import type { Db } from '@wecom/persistence';
import { upsertUser, updateUserAssignment } from '@wecom/persistence';
import { DailyAssistantApp } from './app';
import { getItemMetric, setItemMetric } from './progress-ledger';
import { listWorkItems } from '@wecom/persistence';

export interface SeedUser {
  id: string;
  name: string;
  items: string[];
  confirmDays: number;
}

export const SEED_USERS: SeedUser[] = [
  { id: 'e001', name: '张三', items: ['走访企业5家', '开展活动2场', '梳理合同3项'], confirmDays: 4 },
  { id: 'e002', name: '李四', items: ['业务学习2场', '走访企业3家'], confirmDays: 3 },
  { id: 'e003', name: '王五', items: ['梳理合同2项'], confirmDays: 1 },
];

export const SEED_WEEK = '2026-08-31';
const DATES = ['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04'];

export async function seedDemoData(db: Db): Promise<void> {
  const app = new DailyAssistantApp(db, new MockAgent());
  upsertUser(db, { id: 'manager', name: '演示主管', role: 'dept_head' });
  for (const u of SEED_USERS) {
    app.ensureUser(u.id, u.name);
    updateUserAssignment(db,u.id,'employee','manager');
    app.createWeeklyPlan(u.id, SEED_WEEK, u.items.map((name) => ({ name, planBackground: '' })));
    for(const item of listWorkItems(db,u.id,SEED_WEEK)) setItemMetric(db,{userId:u.id,role:'employee'},item.id,{mode:'percent',unit:'%',rounding:'floor',expectedVersion:getItemMetric(db,item.id)?.version??0});
    for (let i = 0; i < u.confirmDays; i++) {
      const date = DATES[i];
      const draftId = await app.submitRecord(u.id, date, `${u.items[0]}：当日有进展，完成${Math.min(100, (i + 1) * 20)}%`);
      app.completeDailyPresentation(u.id, app.prepareDailyPresentation(u.id, draftId));
      app.confirm(u.id, date, 'button');
    }
    const wrId = await app.generateWeeklyReport(u.id, SEED_WEEK);
    if (u.id === 'e001') app.addFeedback(wrId, '进度不错，下周继续');
  }
  // Seed-only dual-role example: a team lead keeps their own daily work and companies.
  upsertUser(db, { id: 'manager', name: '示例主管', role: 'dept_head' });
  updateUserAssignment(db, 'e001', 'team_lead', 'manager');
  updateUserAssignment(db, 'e002', 'employee', 'e001');
  updateUserAssignment(db, 'e003', 'employee', 'manager');
}
