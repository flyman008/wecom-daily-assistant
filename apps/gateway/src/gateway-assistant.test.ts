import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventMessage, TemplateCard, TextMessage, WsFrame } from '@wecom/aibot-node-sdk';
import { MockAgent } from '@wecom/agent';
import * as repo from '@wecom/persistence';
import { CrmStore } from '../../../packages/persistence/src/crm';
import { ensureActionSchema } from '../../api/src/assistant-actions';
import { notificationSettings } from '../../api/src/notifications';
import { WeComGateway } from './gateway';
import { loadGatewayConfig } from './config';
import { dailyTaskId } from './daily-card';

vi.mock('@wecom/aibot-node-sdk', async (importOriginal) => ({
  ...await importOriginal<typeof import('@wecom/aibot-node-sdk')>(),
  WSClient: class {
    on = vi.fn();
    replyStream = vi.fn().mockResolvedValue({});
    replyWelcome = vi.fn().mockResolvedValue({});
    replyTemplateCard = vi.fn().mockResolvedValue({});
    replyStreamWithCard = vi.fn().mockResolvedValue({});
    sendMessage = vi.fn().mockResolvedValue({});
    updateTemplateCard = vi.fn().mockResolvedValue({});
  },
}));

const gateways: WeComGateway[] = [];
const now = '2026-09-05T04:00:00.000Z';
function setup() {
  const config = loadGatewayConfig({ WECOM_BOT_ID: 'test-only', WECOM_BOT_SECRET: 'test-only' });
  config.databasePath = ':memory:';
  const gateway = new WeComGateway(config, new MockAgent());
  gateways.push(gateway);
  ensureActionSchema(gateway.db);
  for (const [id, role] of [['admin', 'admin'], ['staff', 'employee'], ['other', 'employee']] as const) {
    repo.upsertUser(gateway.db, { id, role, name: `测试${id}`, wecom_userid: `wx-${id}` });
  }
  return gateway;
}
function textFrame(text: string, msgid = 'request-1', userid = 'wx-admin', group = false): WsFrame<TextMessage> {
  return { headers: { req_id: msgid }, body: { msgid, from: { userid }, chattype: group ? 'group' : 'single', ...(group ? { chatid: 'test-group' } : {}), msgtype: 'text', text: { content: text } } } as WsFrame<TextMessage>;
}
function cardFrame(task: string, action = 'confirm_action', userid = 'wx-admin', group = false): WsFrame<EventMessage> {
  return { headers: { req_id: `card-${action}` }, body: { msgid: `card-${action}`, from: { userid }, chattype: group ? 'group' : 'single', ...(group ? { chatid: 'test-group' } : {}), msgtype: 'event', event: { eventtype: 'template_card_event', event_key: action, task_id: task } } } as WsFrame<EventMessage>;
}
function count(gateway: WeComGateway, table: 'source_message' | 'daily_report' | 'knowledge_entry' | 'assistant_action_proposal' | 'crm_event'): number {
  return Number(gateway.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n);
}
function reply(gateway: WeComGateway): string { return String(vi.mocked(gateway.client.replyStream).mock.lastCall?.[2]); }
function lastCard(gateway: WeComGateway): TemplateCard {
  const message = [...vi.mocked(gateway.client.sendMessage).mock.calls].reverse().map(call => call[1]).find(message => message.msgtype === 'template_card');
  expect(message?.msgtype).toBe('template_card');
  return (message as { template_card: TemplateCard }).template_card;
}
function knowledgeText(content = '园区资料原文', title = '园区指南'): string {
  return `新增资料：${title}\n类型：园区资料\n正文：${content}`;
}
function expectNoDaily(gateway: WeComGateway): void {
  expect(count(gateway, 'source_message')).toBe(0);
  expect(count(gateway, 'daily_report')).toBe(0);
}
function insertDaily(gateway: WeComGateway, id: string, userId: string, content: string, status: 'confirmed' | 'pending_confirmation' = 'confirmed'): void {
  repo.insertDailyReport(gateway.db, { id, user_id: userId, report_date: status === 'confirmed' ? '2026-09-04' : '2026-09-05', version: 1, status, summary: content,
    progress_json: '{}', confirmed_at: status === 'confirmed' ? now : null, created_at: now });
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(now)); });
afterEach(() => { gateways.splice(0).forEach(gateway => gateway.db.close()); vi.useRealTimers(); });

describe('机器人操作入口：身份、完整预览、明确确认与日报隔离', () => {
  it('未绑定和群聊不创建提案、不检索资料、不写日报', async () => {
    const gateway = setup();
    for (const text of [knowledgeText(), '设置日报提醒：18:10', '查询资料：园区']) {
      await gateway['handleText'](textFrame(text, 'unbound', 'wx-unbound'));
      expect(reply(gateway)).toContain('绑定');
      await gateway['handleText'](textFrame(text, 'group', 'wx-admin', true));
      expect(reply(gateway)).toContain('私聊');
    }
    expect(count(gateway, 'assistant_action_proposal')).toBe(0);
    expect(count(gateway, 'knowledge_entry')).toBe(0);
    expect(gateway.client.sendMessage).not.toHaveBeenCalled();
    expectNoDaily(gateway);
  });

  it('管理员提案展示超出摘要的全部原文，未确认不写业务；回调只保存一次', async () => {
    const gateway = setup();
    const content = '资料开头' + '原文'.repeat(230) + '末尾核验标识';
    await gateway['handleText'](textFrame(knowledgeText(content)));
    expect(reply(gateway)).toContain(content);
    expect(reply(gateway)).toContain('正文全文开始');
    expect(count(gateway, 'knowledge_entry')).toBe(0);
    expect(count(gateway, 'assistant_action_proposal')).toBe(1);
    expectNoDaily(gateway);
    const task = lastCard(gateway).task_id!;
    await gateway['handleCard'](cardFrame(task));
    expect(count(gateway, 'knowledge_entry')).toBe(1);
    expect(repo.listKnowledgeEntries(gateway.db)[0]?.content).toBe(content);
    await gateway['handleCard'](cardFrame(task));
    expect(reply(gateway)).toContain('没有重复保存');
    expect(count(gateway, 'knowledge_entry')).toBe(1);
    await gateway['handleText'](textFrame(knowledgeText(content)));
    expect(reply(gateway)).toContain('没有重复保存');
    expect(count(gateway, 'assistant_action_proposal')).toBe(1);
    expectNoDaily(gateway);
  });

  it('超过19500字节的中文全文分块完整展示，所有正文发送完成后才给确认卡', async () => {
    const gateway = setup();
    const content = '开始核验' + '资料'.repeat(4000) + '结尾核验';
    expect(Buffer.byteLength(content)).toBeGreaterThan(19_500);
    await gateway['handleText'](textFrame(knowledgeText(content)));
    const messages = vi.mocked(gateway.client.sendMessage).mock.calls.map(call => call[1]);
    const chunks = messages.filter(message => message.msgtype === 'markdown');
    expect(chunks.length).toBeGreaterThan(1);
    const complete = chunks.map(message => message.markdown.content).join('');
    expect(complete.split('——待保存正文全文开始——\n')[1]?.split('\n——待保存正文全文结束——')[0]).toBe(content);
    expect(chunks.every(message => Buffer.byteLength(message.markdown.content) <= 19_000)).toBe(true);
    expect(messages.at(-1)?.msgtype).toBe('template_card');
    expect(messages.slice(0, -1).every(message => message.msgtype === 'markdown')).toBe(true);
    expect(reply(gateway)).toContain('操作预览较长');
    expect(reply(gateway)).not.toContain('日报内容较长');
    expect(count(gateway, 'knowledge_entry')).toBe(0);
    expectNoDaily(gateway);
  });

  it('全文分块发送中途失败，不再发送确认卡且不保存业务', async () => {
    const gateway = setup();
    vi.mocked(gateway.client.sendMessage).mockResolvedValueOnce({} as never).mockRejectedValueOnce(new Error('第二段传输失败'));
    await gateway['handleText'](textFrame(knowledgeText('资料'.repeat(4000))));
    expect(vi.mocked(gateway.client.sendMessage).mock.calls.some(call => call[1].msgtype === 'template_card')).toBe(false);
    expect(reply(gateway)).toContain('第二段传输失败');
    expect(count(gateway, 'knowledge_entry')).toBe(0);
    expectNoDaily(gateway);
  });

  it('其他人、未绑定者、群回调以及伪造token均不能确认，原本人仍可执行', async () => {
    const gateway = setup();
    await gateway['handleText'](textFrame(knowledgeText()));
    const task = lastCard(gateway).task_id!;
    for (const [userid, group] of [['wx-other', false], ['wx-unbound', false], ['wx-admin', true]] as const) {
      await gateway['handleCard'](cardFrame(task, 'confirm_action', userid, group));
      expect(count(gateway, 'knowledge_entry')).toBe(0);
    }
    await gateway['handleCard'](cardFrame(task.replace(/:[^:]+$/, ':wrong-token')));
    expect(count(gateway, 'knowledge_entry')).toBe(0);
    await gateway['handleCard'](cardFrame(task));
    expect(count(gateway, 'knowledge_entry')).toBe(1);
    expectNoDaily(gateway);
  });

  it('员工不能通过机器人配置提醒，管理员也只能在确认后改变对应时间', async () => {
    const gateway = setup();
    const before = notificationSettings(gateway.db);
    await gateway['handleText'](textFrame('设置日报提醒：18:10', 'employee', 'wx-staff'));
    expect(reply(gateway)).toContain('仅管理员');
    expect(count(gateway, 'assistant_action_proposal')).toBe(0);
    await gateway['handleText'](textFrame('设置日报提醒：18:10', 'admin'));
    expect(notificationSettings(gateway.db)).toEqual(before);
    expect(reply(gateway)).toContain('17:30 → 18:10');
    await gateway['handleCard'](cardFrame(lastCard(gateway).task_id!));
    expect(notificationSettings(gateway.db)).toEqual({ ...before, dailyReminderAt: '18:10' });
    expectNoDaily(gateway);
  });

  it('企业跟进只接受有权限企业的精确全称，不改阶段或负责人', async () => {
    const gateway = setup();
    const crm = new CrmStore(gateway.db);
    const mine = crm.saveCompany({ name: '测试企业有限公司', ownerId: 'staff' }, 'admin');
    crm.saveCompany({ name: '外部企业有限公司', ownerId: 'other' }, 'admin');
    const before = crm.detail(mine.id).company;
    const events = count(gateway, 'crm_event');
    for (const companyName of ['测试企业', '外部企业有限公司']) {
      await gateway['handleText'](textFrame(`记录企业跟进：${companyName}\n内容：电话核实材料`, companyName, 'wx-staff'));
      expect(reply(gateway)).toContain('企业名称不唯一、不存在或你无权访问');
    }
    expect(count(gateway, 'assistant_action_proposal')).toBe(0);
    await gateway['handleText'](textFrame('记录企业跟进：测试企业有限公司\n内容：电话核实材料', 'authorized', 'wx-staff'));
    expect(count(gateway, 'crm_event')).toBe(events);
    await gateway['handleCard'](cardFrame(lastCard(gateway).task_id!, 'confirm_action', 'wx-staff'));
    expect(count(gateway, 'crm_event')).toBe(events + 1);
    expect(gateway.db.prepare("SELECT actor_id,content FROM crm_event WHERE kind='followup'").get()).toMatchObject({ actor_id: 'staff', content: '电话核实材料' });
    const after = crm.detail(mine.id).company;
    expect({ ...after, updatedAt: before.updatedAt, lastFollowup: before.lastFollowup }).toEqual(before);
    expectNoDaily(gateway);
  });

  it.each(['edit_action', 'cancel_action'])('%s只取消操作提案，不确认或清除正在编辑的日报', async (action) => {
    const gateway = setup();
    const daily = await gateway.app.submitRecord('admin', '2026-09-05', '今天的实际走访');
    gateway.app.completeDailyPresentation('admin', gateway.app.prepareDailyPresentation('admin', daily));
    await gateway['handleCard'](cardFrame(dailyTaskId(daily), 'edit_daily'));
    const sourceBefore = count(gateway, 'source_message');
    await gateway['handleText'](textFrame(knowledgeText()));
    const task = lastCard(gateway).task_id!;
    await gateway['handleCard'](cardFrame(task, action));
    expect(gateway.db.prepare('SELECT status FROM assistant_action_proposal').get()?.status).toBe('cancelled');
    expect(repo.getDailyReportById(gateway.db, daily)?.status).toBe('pending_confirmation');
    expect(gateway.app.getPendingDailyEdit('admin')?.reportId).toBe(daily);
    expect(count(gateway, 'source_message')).toBe(sourceBefore);
    expect(count(gateway, 'daily_report')).toBe(1);
    await gateway['handleCard'](cardFrame(task));
    expect(reply(gateway)).toContain('已取消');
    expect(count(gateway, 'knowledge_entry')).toBe(0);
  });

  it('卡片发送失败使用操作专用提示，不诱导确认已有日报，业务未写', async () => {
    const gateway = setup();
    const daily = await gateway.app.submitRecord('admin', '2026-09-05', '已有工作草稿');
    gateway.app.completeDailyPresentation('admin', gateway.app.prepareDailyPresentation('admin', daily));
    vi.mocked(gateway.client.sendMessage).mockRejectedValueOnce(new Error('模拟卡片发送失败'));
    await gateway['handleText'](textFrame(knowledgeText()));
    const fallback = vi.mocked(gateway.client.sendMessage).mock.lastCall?.[1];
    expect(fallback?.msgtype).toBe('markdown');
    expect(JSON.stringify(fallback)).toContain('普通文字确认不会执行此操作');
    expect(JSON.stringify(fallback)).not.toContain('确认日报');
    expect(repo.getDailyReportById(gateway.db, daily)?.status).toBe('pending_confirmation');
    expect(count(gateway, 'knowledge_entry')).toBe(0);
    expect(count(gateway, 'daily_report')).toBe(1);
  });

  it('已提交动作的回执发送失败不会导致再次执行业务写入', async () => {
    const gateway = setup();
    await gateway['handleText'](textFrame(knowledgeText()));
    const task = lastCard(gateway).task_id!;
    vi.mocked(gateway.client.replyStream).mockRejectedValueOnce(new Error('回执失败'));
    await expect(gateway['handleCard'](cardFrame(task))).rejects.toThrow('回执失败');
    expect(count(gateway, 'knowledge_entry')).toBe(1);
    await gateway['handleCard'](cardFrame(task));
    expect(reply(gateway)).toContain('没有重复保存');
    expect(count(gateway, 'knowledge_entry')).toBe(1);
  });

  it('查询历史只回本人已确认事实，不泄露别人日报或未确认草稿，也不新写记录', async () => {
    const gateway = setup();
    insertDaily(gateway, 'my-confirmed', 'staff', '园区授权历史事实');
    insertDaily(gateway, 'other-confirmed', 'other', '园区其他人机密事实');
    insertDaily(gateway, 'my-draft', 'staff', '园区尚未确认内容', 'pending_confirmation');
    const changesBefore = gateway.db.prepare('SELECT total_changes() AS n').get()?.n;
    await gateway['handleText'](textFrame('查询历史：园区', 'lookup', 'wx-staff'));
    expect(reply(gateway)).toContain('园区授权历史事实');
    expect(reply(gateway)).toContain('2026-09-04');
    expect(reply(gateway)).not.toMatch(/其他人机密|尚未确认内容/);
    expect(gateway.db.prepare('SELECT total_changes() AS n').get()?.n).toBe(changesBefore);
    expect(count(gateway, 'source_message')).toBe(0);
  });

  it('知识查询只展示明确关联、当前启用和有权企业资料', async () => {
    const gateway = setup();
    const crm = new CrmStore(gateway.db);
    const mine = crm.saveCompany({ name: '本人企业', ownerId: 'staff' }, 'admin');
    const other = crm.saveCompany({ name: '别人的企业', ownerId: 'other' }, 'admin');
    for (const id of ['mine', 'other', 'unlinked', 'disabled']) {
      repo.createKnowledgeEntry(gateway.db, { id, kind: 'park_material', title: `园区${id}`, summary: '', content: `园区${id}资料原文`, tags_json: '[]', source_name: '', created_at: now, updated_at: now });
    }
    crm.link(mine.id, { knowledgeId: 'mine' }, 'admin');
    crm.link(mine.id, { knowledgeId: 'disabled' }, 'admin');
    crm.link(other.id, { knowledgeId: 'other' }, 'admin');
    gateway.db.prepare("UPDATE knowledge_entry SET active=0 WHERE id='disabled'").run();
    await gateway['handleText'](textFrame('查询资料：园区', 'knowledge', 'wx-staff'));
    expect(reply(gateway)).toContain('园区mine资料原文');
    expect(reply(gateway)).not.toMatch(/other|unlinked|disabled/);
    expectNoDaily(gateway);
  });

  it('无效操作指令返回格式说明，不作为日报或提案保存', async () => {
    const gateway = setup();
    for (const text of ['新增资料：标题\n正文：缺少类型', '记录企业跟进：没有正文', '设置日报提醒：明天', '查询历史', '查历史', '查资料 园区']) {
      await gateway['handleText'](textFrame(text));
    }
    expect(count(gateway, 'assistant_action_proposal')).toBe(0);
    expectNoDaily(gateway);
  });

  it('拒绝同周未来补记，不生成日报或保留未来工作事实', async () => {
    const gateway = setup();
    await gateway['handleText'](textFrame('补记 2026-09-06：明天准备走访', 'future', 'wx-staff'));
    expect(reply(gateway)).toContain('不能把未来计划');
    expectNoDaily(gateway);
  });

  it('不存在日期即使可被Date归一到当前周仍拒绝入库', async () => {
    vi.setSystemTime(new Date('2026-03-02T04:00:00.000Z'));
    const gateway = setup();
    await gateway['handleText'](textFrame('补记 2026-02-30：不存在日期的记录', 'invalid-date', 'wx-staff'));
    expect(reply(gateway)).toContain('日期');
    expect(reply(gateway)).not.toContain('原始记录已经保存');
    expectNoDaily(gateway);
  });
});
