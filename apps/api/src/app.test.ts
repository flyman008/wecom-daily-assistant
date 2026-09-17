import { describe, expect, it } from 'vitest';
import { MockAgent, type Agent, type AgentTaskRequest } from '@wecom/agent';
import { createKnowledgeEntry, openDb, upsertUser } from '@wecom/persistence';
import { DailyAssistantApp } from './app';
import { CrmStore } from '../../../packages/persistence/src/crm';

function setup(agent: Agent = new MockAgent()) {
  const db = openDb(':memory:');
  const app = new DailyAssistantApp(db, agent);
  app.createWeeklyPlan('e001', '2026-08-31', [{ name: '走访企业', planBackground: '' }]);
  return { db, app };
}

describe('原始消息、幂等与日报版本', () => {
  it('同日多条消息聚合为新的不可变草稿版本', async () => {
    const { db, app } = setup();
    const first = await app.submitRecord('e001', '2026-09-04', '上午走访A', { messageId: 'm1' });
    const second = await app.submitRecord('e001', '2026-09-04', '下午跟进B', { messageId: 'm2' });
    expect(second).not.toBe(first);
    expect((db.prepare('SELECT COUNT(1) AS n FROM source_message').get() as { n: number }).n).toBe(2);
    expect((db.prepare('SELECT COUNT(1) AS n FROM daily_report').get() as { n: number }).n).toBe(2);
  });

  it('重复msgid不会重复写入或重复生成版本', async () => {
    const { db, app } = setup();
    const first = await app.submitRecord('e001', '2026-09-04', '走访A', { messageId: 'same' });
    const second = await app.submitRecord('e001', '2026-09-04', '重复投递', { messageId: 'same' });
    expect(second).toBe(first);
    expect((db.prepare('SELECT COUNT(1) AS n FROM source_message').get() as { n: number }).n).toBe(1);
  });

  it('确认后新增记录创建新版本并保留旧版本', async () => {
    const { db, app } = setup();
    const draftId = await app.submitRecord('e001', '2026-09-04', '走访A', { messageId: 'm1' });
    app.completeDailyPresentation('e001', app.prepareDailyPresentation('e001', draftId));
    app.confirm('e001', '2026-09-04', 'button');
    await app.submitRecord('e001', '2026-09-04', '补充跟进B', { messageId: 'm2' });
    const rows = db.prepare('SELECT version, status FROM daily_report ORDER BY version').all() as Array<{ version: number; status: string }>;
    expect(rows).toEqual([{ version: 1, status: 'confirmed' }, { version: 2, status: 'pending_confirmation' }]);
  });

  it('Agent失败时仍保留原始消息', async () => {
    const failing: Agent = { run: async () => { throw new Error('模型不可用'); } };
    const { db, app } = setup(failing);
    await expect(app.submitRecord('e001', '2026-09-04', '不能丢', { messageId: 'm1' })).rejects.toThrow('模型不可用');
    const row = db.prepare('SELECT text_content, process_status FROM source_message WHERE msg_id=?').get('m1') as { text_content: string; process_status: string };
    expect(row).toEqual({ text_content: '不能丢', process_status: 'agent_failed' });
  });
});

describe('应用层业务规则', () => {
  it('拒绝超过事项上限', () => {
    const db = openDb(':memory:');
    const app = new DailyAssistantApp(db, new MockAgent());
    const items = Array.from({ length: 11 }, (_, index) => ({ name: `事项${index + 1}`, planBackground: '' }));
    expect(() => app.createWeeklyPlan('e001', '2026-08-31', items)).toThrow('最多 10 项');
  });

  it('领导反馈同时写入Outbox', async () => {
    const { db, app } = setup();
    const draftId = await app.submitRecord('e001', '2026-09-04', '走访A', { messageId: 'm1' });
    app.completeDailyPresentation('e001', app.prepareDailyPresentation('e001', draftId));
    app.confirm('e001', '2026-09-04', 'button');
    const weeklyId = await app.generateWeeklyReport('e001', '2026-08-31');
    expect(() => app.addFeedback(weeklyId, '不能自动创领导', null, 'leader1')).toThrow('反馈人不存在');
    expect(db.prepare("SELECT id FROM app_user WHERE id='leader1'").get()).toBeUndefined();
    upsertUser(db, { id: 'leader1', role: 'team_lead' });
    db.prepare("UPDATE app_user SET manager_user_id='leader1' WHERE id='e001'").run();
    app.addFeedback(weeklyId, '继续跟进', null, 'leader1');
    expect((db.prepare('SELECT COUNT(1) AS n FROM manager_feedback').get() as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT COUNT(1) AS n FROM message_outbox').get() as { n: number }).n).toBe(1);
  });

  it('收到员工消息不会覆盖后台维护的姓名、角色和汇报关系', async () => {
    const db = openDb(':memory:');
    const app = new DailyAssistantApp(db, new MockAgent());
    app.ensureUser('m001', '主管');
    db.prepare("UPDATE app_user SET role='team_lead' WHERE id='m001'").run();
    app.ensureUser('e001', '张三');
    db.prepare("UPDATE app_user SET manager_user_id='m001' WHERE id='e001'").run();
    app.createWeeklyPlan('e001', '2026-08-31', [{ name: '走访企业', planBackground: '' }]);
    await app.submitRecord('e001', '2026-09-04', '走访企业完成20%', { messageId: 'preserve-profile' });
    expect(db.prepare('SELECT name, role, manager_user_id FROM app_user WHERE id=?').get('e001')).toEqual({
      name: '张三', role: 'employee', manager_user_id: 'm001',
    });
  });

  it('仅把与本次任务相关的启用知识片段交给Agent', async () => {
    let captured: AgentTaskRequest | undefined;
    const mock = new MockAgent();
    const capturing: Agent = { run: async (request) => { captured = request; return mock.run(request); } };
    const { db, app } = setup(capturing);
    createKnowledgeEntry(db, {
      id: 'company-a', kind: 'service_company', title: 'A企业', summary: '重点服务企业', content: '落地诉求',
      tags_json: '["A企"]', source_name: '企业台账', created_at: '2026-09-05T00:00:00.000Z', updated_at: '2026-09-05T00:00:00.000Z',
    });
    createKnowledgeEntry(db, {
      id: 'company-b', kind: 'service_company', title: 'B企业', summary: '', content: '其他企业资料',
      tags_json: '[]', source_name: '', created_at: '2026-09-05T00:00:00.000Z', updated_at: '2026-09-05T00:00:00.000Z',
    });
    const crm = new CrmStore(db);
    const company = crm.saveCompany({ name: 'A企业', ownerId: 'e001' }, 'e001');
    crm.link(company.id, { knowledgeId: 'company-a' }, 'e001');
    await app.submitRecord('e001', '2026-09-04', '今天走访A企业，沟通落地诉求', { messageId: 'knowledge-context' });
    expect(captured?.context.knowledgeSnippets?.map((entry) => entry.id)).toContain('company-a');
    expect(captured?.context.knowledgeSnippets?.map((entry) => entry.id)).not.toContain('company-b');
  });

  it('事项修改保留版本，周一事项从周二起禁止删除', () => {
    const db = openDb(':memory:');
    const app = new DailyAssistantApp(db, new MockAgent());
    const monday = new Date('2026-08-31T04:00:00Z');
    const tuesday = new Date('2026-09-01T04:00:00Z');
    app.createWeeklyPlan('e001', '2026-08-31', [{ name: '走访企业', planBackground: '计划走访5家' }], monday);
    const original = db.prepare('SELECT * FROM work_item').get() as { id: string; version: number };
    const updated = app.updateWeeklyPlanItem('e001', original.id, original.version, {
      name: '走访重点企业', planBackground: '计划走访5家，其中2家重点企业',
    }, tuesday);
    expect(updated.version).toBe(2);
    expect(() => app.deleteWeeklyPlanItem('e001', original.id, updated.version, tuesday)).toThrow('已锁定');
    expect((db.prepare('SELECT COUNT(1) AS n FROM work_item_revision').get() as { n: number }).n).toBe(2);
  });

  it('周二追加事项仍可删除并保留删除版本', () => {
    const db = openDb(':memory:');
    const app = new DailyAssistantApp(db, new MockAgent());
    const tuesday = new Date('2026-09-01T04:00:00Z');
    app.createWeeklyPlan('e001', '2026-08-31', [{ name: '临时活动', planBackground: '' }], tuesday);
    const item = db.prepare('SELECT * FROM work_item').get() as { id: string; version: number };
    app.deleteWeeklyPlanItem('e001', item.id, item.version, tuesday);
    expect((db.prepare('SELECT deleted FROM work_item WHERE id=?').get(item.id) as { deleted: number }).deleted).toBe(1);
    expect((db.prepare('SELECT COUNT(1) AS n FROM work_item_revision').get() as { n: number }).n).toBe(2);
  });
});
