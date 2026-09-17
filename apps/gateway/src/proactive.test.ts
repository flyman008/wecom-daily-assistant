import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockAgent } from '@wecom/agent';
import * as repo from '@wecom/persistence';
import { CrmStore } from '../../../packages/persistence/src/crm';
import { DailyAssistantApp } from '../../api/src/app';
import { DEFAULT_NOTIFICATION_SETTINGS, notificationOverview, notificationSettings, retryNotification, updateNotificationSettings } from '../../api/src/notifications';
import { getWeeklyInstance, saveWeeklyFeedback, saveWeeklyReason } from '../../api/src/weekly-workflow';
import { setItemMetric } from '../../api/src/progress-ledger';
import { loadGatewayConfig } from './config';
import { dueWeeklyTarget, ProactiveService } from './proactive';

const opened: repo.Db[] = [];
const friday = new Date('2026-09-04T10:05:00.000Z'); // Shanghai Friday 18:05, deliberately after exact schedule minute.
function setup() {
  const db = repo.openDb(':memory:'); opened.push(db);
  const app = new DailyAssistantApp(db, new MockAgent());
  repo.upsertUser(db, { id: 'boss', wecom_userid: 'wx-boss', name: '部门负责人', role: 'dept_head' });
  repo.upsertUser(db, { id: 'lead', wecom_userid: 'wx-lead', name: '兼岗组长', role: 'team_lead', manager_user_id: 'boss' });
  repo.upsertUser(db, { id: 'staff', wecom_userid: 'wx-staff', name: '员工甲', manager_user_id: 'lead' });
  const config = loadGatewayConfig({ WECOM_BOT_ID: 'mock', WECOM_BOT_SECRET: 'mock', REPORT_BASE_URL: 'http://localhost:8792' });
  const client = { isConnected: true, sendMessage: vi.fn().mockResolvedValue({}) };
  const service = new ProactiveService(db, app, config, client);
  updateNotificationSettings(db, { planReminderEnabled: false, dailyReminderEnabled: false, weeklyReportEnabled: false }, 'boss');
  return { db, app, config, client, service };
}
async function confirm(app: DailyAssistantApp, id = 'staff') {
  const report = await app.submitRecord(id, '2026-09-04', '走访企业，核实场地需求');
  app.completeDailyPresentation(id, app.prepareDailyPresentation(id, report));
  app.confirmReport(id, report, 'button');
  return report;
}
function enqueue(db: repo.Db, kind: string, payload: unknown, target = 'staff', id = 'outbox-1') {
  repo.insertOutbox(db, { id, kind, target_user_id: target, dedupe_key: id, payload_json: JSON.stringify(payload), next_attempt_at: friday.toISOString(), created_at: friday.toISOString() });
}
afterEach(() => { for (const db of opened.splice(0)) db.close(); });

describe('主动消息调度与可审计发送', () => {
  it('周一错过精确分钟仍补发；多tick与重新实例化不重复，兼岗组长也提醒', async () => {
    const { db, app, config, client, service } = setup();
    updateNotificationSettings(db, { planReminderEnabled: true }, 'boss');
    const monday = new Date('2026-09-07T01:08:00Z');
    await service.tick(monday);
    await service.tick(monday);
    await new ProactiveService(db, app, config, client).tick(monday);
    expect(client.sendMessage).toHaveBeenCalledTimes(3);
    expect(client.sendMessage.mock.calls.map((call) => call[0])).toContain('wx-lead');
    expect(notificationOverview(db).queue).toHaveLength(3);
  });
  it('日报区分未提交和待确认；已确认不再提醒', async () => {
    const { db, app, client, service } = setup();
    await app.submitRecord('staff', '2026-09-04', '今天已提交草稿');
    await confirm(app, 'boss');
    updateNotificationSettings(db, { dailyReminderEnabled: true }, 'boss');
    await service.tick(friday);
    expect(client.sendMessage).toHaveBeenCalledTimes(2);
    expect(client.sendMessage.mock.calls.find((call) => call[0] === 'wx-staff')?.[1].markdown.content).toContain('草稿还未确认');
    expect(client.sendMessage.mock.calls.find((call) => call[0] === 'wx-lead')?.[1].markdown.content).toContain('还没有已确认日报');
  });
  it('出队前重新检查日报完成情况，旧提醒撤销', async () => {
    const { db, app, client, service } = setup();
    updateNotificationSettings(db, { dailyReminderEnabled: true }, 'boss');
    enqueue(db, 'daily_reminder', { date: '2026-09-04' });
    await confirm(app);
    await service.flushOutbox(friday);
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(notificationOverview(db).queue[0]).toMatchObject({ status: 'cancelled' });
  });
  it('组长本人周报发给上级、员工周报发给组长，持久任务避免重复生成', async () => {
    const { db, app, config, client, service } = setup();
    await confirm(app, 'staff'); await confirm(app, 'lead');
    updateNotificationSettings(db, { weeklyReportEnabled: true, weeklyWeekday: 5, weeklyTarget: 'current' }, 'boss');
    await Promise.all([service.tick(friday), new ProactiveService(db, app, config, client).tick(friday)]);
    await service.tick(friday);
    expect(client.sendMessage).toHaveBeenCalledTimes(2);
    expect(new Set(client.sendMessage.mock.calls.map((call) => call[0]))).toEqual(new Set(['wx-lead', 'wx-boss']));
    expect(client.sendMessage.mock.calls.every((call) => call[1].markdown.content.includes('http://localhost:8792/weekly.html#/access/'))).toBe(true);
    expect((db.prepare('SELECT COUNT(*) n FROM weekly_report').get() as { n: number }).n).toBe(2);
    expect((db.prepare('SELECT COUNT(*) n FROM access_grant').get() as { n: number }).n).toBe(2);
    expect(JSON.stringify(notificationOverview(db))).not.toContain('/#/access/');
  });
  it('汇报关系或角色变化后不能把周报发给旧经理', async () => {
    const { db, app, client, service } = setup();
    await confirm(app);
    const reportId = await app.generateWeeklyReport('staff', '2026-08-31');
    updateNotificationSettings(db, { weeklyReportEnabled: true }, 'boss');
    enqueue(db, 'weekly_report', { reportId }, 'lead');
    db.prepare("UPDATE app_user SET manager_user_id='boss' WHERE id='staff'").run();
    await service.flushOutbox(friday);
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(notificationOverview(db).queue[0]).toMatchObject({ status: 'cancelled' });
  });
  it('反馈从正式库读取，不采用被篡改的outbox内容；只发给本人', async () => {
    const { db, app, client, service } = setup();
    await confirm(app);
    const reportId = await app.generateWeeklyReport('staff', '2026-08-31');
    const id = app.addFeedback(reportId, '请补充场地需求', null, 'lead');
    db.prepare('UPDATE message_outbox SET payload_json=?,next_attempt_at=?').run(JSON.stringify({ feedbackId: id, content: '攻击内容' }), friday.toISOString());
    await service.flushOutbox(friday);
    expect(client.sendMessage.mock.lastCall?.[0]).toBe('wx-staff');
    expect(client.sendMessage.mock.lastCall?.[1].markdown.content).toContain('请补充场地需求');
    expect(client.sendMessage.mock.lastCall?.[1].markdown.content).not.toContain('攻击内容');
  });
  it('断线不出队；发送失败重试成功，错误与授权URL不泄露到后台', async () => {
    const { db, client, service } = setup();
    updateNotificationSettings(db, { dailyReminderEnabled: true }, 'boss');
    enqueue(db, 'daily_reminder', { date: '2026-09-04' });
    client.isConnected = false;
    await service.flushOutbox(friday);
    expect(notificationOverview(db).queue[0]).toMatchObject({ status: 'pending', attempts: 0 });
    client.isConnected = true;
    client.sendMessage.mockRejectedValueOnce(new Error('sensitive token https://example.test/secret'));
    await service.flushOutbox(friday);
    expect(notificationOverview(db).queue[0]).toMatchObject({ status: 'failed', attempts: 1 });
    expect(JSON.stringify(notificationOverview(db))).not.toContain('secret');
    await service.flushOutbox(new Date(friday.getTime() + 6_000));
    expect(notificationOverview(db).queue[0]).toMatchObject({ status: 'sent', attempts: 2 });
  });
  it('停用人员撤销、未绑定人员不回退到内部ID，手动重试仍复核绑定', async () => {
    const { db, client, service } = setup();
    updateNotificationSettings(db, { dailyReminderEnabled: true, maxAttempts: 1 }, 'boss');
    enqueue(db, 'daily_reminder', { date: '2026-09-04' });
    db.prepare("UPDATE app_user SET wecom_userid='pending:staff' WHERE id='staff'").run();
    await service.flushOutbox(friday);
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(notificationOverview(db).queue[0]).toMatchObject({ status: 'failed', can_retry: 1 });
    retryNotification(db, 'outbox-1', 'boss', 'poc', friday);
    db.prepare("UPDATE app_user SET active=0 WHERE id='staff'").run();
    await service.flushOutbox(friday);
    expect(notificationOverview(db).queue[0]).toMatchObject({ status: 'cancelled', can_retry: 0 });
    expect(() => retryNotification(db, 'outbox-1', 'boss')).toThrow('仅失败');
  });
  it('CRM默认不推送；启用后新增分配和到期事项只通知负责人并幂等', async () => {
    const { db, client, service } = setup();
    const crm = new CrmStore(db);
    const company = crm.saveCompany({ name: '测试企业', ownerId: 'staff', nextDate: '2026-09-04', nextAction: '电话确认' }, 'boss');
    await service.tick(friday);
    expect(client.sendMessage).not.toHaveBeenCalled();
    updateNotificationSettings(db, { crmAssignmentEnabled: true, crmDueEnabled: true }, 'boss', 'poc', new Date('2020-01-01'));
    await service.tick(friday);
    await service.tick(friday);
    expect(client.sendMessage).toHaveBeenCalledTimes(2);
    expect(client.sendMessage.mock.calls.every((call) => call[0] === 'wx-staff')).toBe(true);
    expect(client.sendMessage.mock.calls.some((call) => call[1].markdown.content.includes('新的企业协作分工'))).toBe(true);
    expect(client.sendMessage.mock.calls.some((call) => call[1].markdown.content.includes('跟进提醒'))).toBe(true);
    expect(company.id).toBeTruthy();
  });
  it('CRM改派、已解决、已归档均拦截旧通知', async () => {
    const { db, client, service } = setup();
    const crm = new CrmStore(db);
    const company = crm.saveCompany({ name: '改派企业', ownerId: 'staff', nextDate: '2026-09-04' }, 'boss');
    const item = crm.saveRecord(company.id, 'service', { title: '材料办理', ownerId: 'staff', dueDate: '2026-09-04' }, 'boss');
    updateNotificationSettings(db, { crmAssignmentEnabled: true, crmDueEnabled: true }, 'boss');
    enqueue(db, 'crm_assignment', { companyId: company.id });
    enqueue(db, 'crm_due', { companyId: company.id, recordId: item.id, dueDate: '2026-09-04', date: '2026-09-04' }, 'staff', 'due');
    crm.saveCompany({ version: 1, ownerId: 'lead', reason: '调整分工' }, 'boss', company.id);
    crm.saveRecord(company.id, 'service', { version: 1, status: 'resolved', outcome: '完成', reason: '已办结' }, 'boss', item.id);
    await service.flushOutbox(friday);
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(notificationOverview(db).queue.every((row: any) => row.status === 'cancelled')).toBe(true);
  });
  it('老板反馈在免打扰时优先送达，日报保持静默，重复轮询不重复发送', async () => {
    const { db, app, client, service } = setup();
    await confirm(app);
    const reportId = await app.generateWeeklyReport('staff', '2026-08-31');
    app.addFeedback(reportId, '请优先协调园区用电', null, 'lead');
    db.prepare('UPDATE message_outbox SET next_attempt_at=?').run(friday.toISOString());
    updateNotificationSettings(db, { dailyReminderEnabled: true }, 'boss');
    for(let i=0;i<35;i++) enqueue(db,'daily_reminder',{date:'2026-09-04'},'lead',`nudge-${i}`);
    const night=new Date('2026-09-04T14:00:00Z');
    await service.flushOutbox(night); await service.flushOutbox(night);
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(client.sendMessage.mock.lastCall?.[0]).toBe('wx-staff');
    expect(client.sendMessage.mock.lastCall?.[1].markdown.content).toContain('请优先协调园区用电');
    expect(notificationOverview(db).queue.filter((row:any)=>row.kind==='daily_reminder').every((row:any)=>row.status==='pending')).toBe(true);
  });
  it('免打扰不发送，次日不补发过期日报提醒；停用规则不出队', async () => {
    const { db, client, service } = setup();
    enqueue(db, 'daily_reminder', { date: '2026-09-04' });
    await service.flushOutbox(friday);
    expect(client.sendMessage).not.toHaveBeenCalled();
    updateNotificationSettings(db, { dailyReminderEnabled: true }, 'boss');
    await service.flushOutbox(new Date('2026-09-04T14:00:00Z'));
    expect(notificationOverview(db).queue[0]).toMatchObject({ status: 'pending' });
    await service.flushOutbox(new Date('2026-09-05T02:00:00Z'));
    expect(notificationOverview(db).queue[0]).toMatchObject({ status: 'cancelled' });
  });
  it('通知配置校验且审计，队列不含payload；只允许失败重试', () => {
    const { db } = setup();
    expect(() => updateNotificationSettings(db, { dailyReminderAt: '25:00' }, 'boss')).toThrow('HH:mm');
    expect(() => updateNotificationSettings(db, { maxAttempts: 30 }, 'boss')).toThrow('1到10');
    enqueue(db, 'weekly_report', { reportUrl: 'http://secret' });
    expect(JSON.stringify(notificationOverview(db))).not.toContain('http://secret');
    expect(() => retryNotification(db, 'outbox-1', 'boss')).toThrow('仅失败');
  });
  it('ACK超时结果不确定，不自动重发；需管理员核对后重试', async () => {
    const { db, client, service } = setup();
    updateNotificationSettings(db, { dailyReminderEnabled: true }, 'boss');
    enqueue(db, 'daily_reminder', { date: '2026-09-04' });
    client.sendMessage.mockRejectedValueOnce(new Error('Reply ack timeout (5000ms) for reqId: mock'));
    await service.flushOutbox(friday);
    await service.flushOutbox(new Date(friday.getTime() + 60_000));
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(notificationOverview(db).queue[0]).toMatchObject({ status: 'failed', last_error: '发送结果不确定，请核对后手动重试' });
    retryNotification(db, 'outbox-1', 'boss', 'poc', friday);
    await service.flushOutbox(friday);
    expect(client.sendMessage).toHaveBeenCalledTimes(2);
  });
  it('进程重启不抢占未过期发送，过期租约进入待核对而非盲目重发', async () => {
    const { db, app, config, client, service } = setup();
    updateNotificationSettings(db, { dailyReminderEnabled: true }, 'boss');
    enqueue(db, 'daily_reminder', { date: '2026-09-04' });
    db.prepare("UPDATE message_outbox SET status='sending' WHERE id='outbox-1'").run();
    db.prepare('INSERT INTO notification_delivery(outbox_id,lease_until) VALUES(?,?)').run('outbox-1', new Date(friday.getTime() + 60_000).toISOString());
    await new ProactiveService(db, app, config, client).flushOutbox(friday);
    expect(notificationOverview(db).queue[0]).toMatchObject({ status: 'sending' });
    await service.flushOutbox(new Date(friday.getTime() + 61_000));
    expect(notificationOverview(db).queue[0]).toMatchObject({ status: 'failed', can_retry: 1 });
    expect(client.sendMessage).not.toHaveBeenCalled();
  });
  it('仅处理本租户消息；未知资源或旧URL-only消息不可发送', async () => {
    const { db, client, service } = setup();
    db.prepare('INSERT INTO tenant(id,name,created_at) VALUES(?,?,?)').run('other', 'Other', friday.toISOString());
    repo.insertOutbox(db, { id: 'foreign', tenant_id: 'other', kind: 'daily_reminder', dedupe_key: 'foreign', target_user_id: 'staff', payload_json: JSON.stringify({ date: '2026-09-04' }), next_attempt_at: friday.toISOString(), created_at: friday.toISOString() });
    enqueue(db, 'weekly_report', { reportUrl: 'http://untrusted' });
    updateNotificationSettings(db, { dailyReminderEnabled: true, weeklyReportEnabled: true }, 'boss');
    await service.flushOutbox(friday);
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect((db.prepare("SELECT status FROM message_outbox WHERE id='foreign'").get() as { status: string }).status).toBe('pending');
    expect(notificationOverview(db).queue[0]).toMatchObject({ status: 'cancelled' });
  });
  it('手工周报的来源过旧时定时任务重新生成，不能沿用旧内容', async () => {
    const { db, app, service } = setup();
    await confirm(app);
    await app.generateWeeklyReport('staff', '2026-08-31');
    const next = await app.submitRecord('staff', '2026-09-04', '补充：完成材料核对');
    app.completeDailyPresentation('staff', app.prepareDailyPresentation('staff', next));
    app.confirmReport('staff', next, 'button');
    updateNotificationSettings(db, { weeklyReportEnabled: true, weeklyWeekday: 5, weeklyTarget: 'current' }, 'boss');
    await service.tick(friday);
    expect((db.prepare('SELECT COUNT(*) n FROM weekly_report').get() as { n: number }).n).toBe(2);
    expect(repo.getWeeklyReport(db, 'staff', '2026-08-31')?.cited_report_ids_json).toContain(next);
  });
  it('新安装默认周一九点发上一自然周，跨日仅补最近排期且处理跨年', () => {
    const db = repo.openDb(':memory:'); opened.push(db);
    expect(notificationSettings(db)).toMatchObject({ weeklyWeekday: 1, weeklyGenerateAt: '09:00', weeklyTarget: 'previous', catchupDays: 2, riskEnabled: false });
    expect(dueWeeklyTarget(new Date('2026-09-07T00:59:00Z'), DEFAULT_NOTIFICATION_SETTINGS)).toBeUndefined();
    expect(dueWeeklyTarget(new Date('2026-09-07T01:00:00Z'), DEFAULT_NOTIFICATION_SETTINGS)).toBe('2026-08-31');
    expect(dueWeeklyTarget(new Date('2026-09-09T12:00:00Z'), DEFAULT_NOTIFICATION_SETTINGS)).toBe('2026-08-31');
    expect(dueWeeklyTarget(new Date('2026-09-10T01:00:00Z'), DEFAULT_NOTIFICATION_SETTINGS)).toBeUndefined();
    expect(dueWeeklyTarget(new Date('2027-01-04T01:00:00Z'), DEFAULT_NOTIFICATION_SETTINGS)).toBe('2026-12-28');
  });
  it('旧显式排期未指定目标周时保留当周，不在保存其他配置时悄悄移成上一周', () => {
    const db = repo.openDb(':memory:'); opened.push(db);
    repo.setConfig(db, 'notifications', { weeklyWeekday: 5, weeklyGenerateAt: '18:30' });
    expect(notificationSettings(db)).toMatchObject({ weeklyTarget: 'current', weeklyWeekday: 5, weeklyGenerateAt: '18:30' });
    expect(notificationOverview(db).compatibilityNote).toContain('旧排期');
    updateNotificationSettings(db, { riskEnabled: true }, 'boss');
    expect(notificationSettings(db).weeklyTarget).toBe('current');
    updateNotificationSettings(db, { weeklyTarget: 'previous', weeklyWeekday: 1, weeklyGenerateAt: '09:00' }, 'boss');
    expect(notificationOverview(db).compatibilityNote).toBeNull();
    const legacy = repo.openDb(':memory:'); opened.push(legacy);
    repo.setConfig(legacy, 'weeklyGenerateAt', '19:00');
    expect(notificationSettings(legacy)).toMatchObject({ weeklyTarget: 'current', weeklyWeekday: 7, weeklyGenerateAt: '19:00' });
  });
  it('独立提醒日不随周报边界改变，空日历不提醒，校验新配置', async () => {
    const { db, app, client, service } = setup();
    repo.setConfig(db, 'weekBoundary', 'work_week');
    updateNotificationSettings(db, { dailyReminderEnabled: true, dailyReminderDays: [6] }, 'boss');
    await service.tick(friday);
    expect(client.sendMessage).not.toHaveBeenCalled();
    await service.tick(new Date('2026-09-05T10:05:00Z'));
    expect(client.sendMessage).toHaveBeenCalledTimes(3);
    updateNotificationSettings(db, { dailyReminderDays: [] }, 'boss');
    expect(notificationSettings(db).dailyReminderDays).toEqual([]);
    expect(app.weekBoundary).toBe('work_week');
    for (const input of [{ dailyReminderDays: [1, 1] }, { dailyReminderDays: [0] }, { weeklyTarget: 'next' }, { catchupDays: 7 }, { riskThreshold: -1 }, { riskEarliestWeekday: 0 }, { riskEnabled: 'true' }]) {
      expect(() => updateNotificationSettings(db, input, 'boss')).toThrow();
    }
  });
  it('周一只汇总上一周，零日报及未绑定员工提醒当前管理者，停用人员不参与', async () => {
    const { db, app, client, service } = setup();
    await confirm(app);
    repo.upsertUser(db, { id: 'unbound', wecom_userid: 'pending:unbound', name: '未绑定员工', manager_user_id: 'lead' });
    repo.upsertUser(db, { id: 'inactive', wecom_userid: 'wx-inactive', name: '停用员工', manager_user_id: 'lead' });
    db.prepare("UPDATE app_user SET active=0 WHERE id='inactive'").run();
    updateNotificationSettings(db, { weeklyReportEnabled: true, weeklyGenerateAt: '09:00', weeklyTarget: 'previous', weeklyWeekday: 1 }, 'boss');
    const monday = new Date('2026-09-07T01:05:00Z');
    await service.tick(monday); await service.tick(monday);
    expect(repo.getWeeklyReport(db, 'staff', '2026-08-31')).toBeTruthy();
    expect(repo.getWeeklyReport(db, 'staff', '2026-09-07')).toBeUndefined();
    expect(repo.getWeeklyReport(db, 'unbound', '2026-08-31')).toBeUndefined();
    expect(client.sendMessage).toHaveBeenCalledTimes(3); // staff report, lead missing, unbound missing
    const messages = client.sendMessage.mock.calls.map(call => call[1].markdown.content);
    expect(messages.some(text => text.includes('未绑定员工') && text.includes('暂无已确认日报'))).toBe(true);
    expect(messages.some(text => text.includes('停用员工'))).toBe(false);
  });
  it('跨日补发周计划及周报，超过窗口不制造历史提醒', async () => {
    const { db, app, client, service } = setup();
    await confirm(app);
    updateNotificationSettings(db, { planReminderEnabled: true, weeklyReportEnabled: true, weeklyGenerateAt: '09:00', catchupDays: 2 }, 'boss');
    const tuesday = new Date('2026-09-08T02:00:00Z');
    await service.tick(tuesday);
    expect(client.sendMessage.mock.calls.some(call => call[1].markdown.content.includes('新的一周'))).toBe(true);
    expect(repo.getWeeklyReport(db, 'staff', '2026-08-31')).toBeTruthy();
    const before = client.sendMessage.mock.calls.length;
    await service.tick(new Date('2026-09-10T02:00:00Z'));
    expect(client.sendMessage).toHaveBeenCalledTimes(before);
  });
  it('完成的定时任务遇来源修订后发布新版本并只发一次更正；旧排队版本拦截', async () => {
    const { db, app, client, service } = setup();
    await confirm(app);
    updateNotificationSettings(db, { weeklyReportEnabled: true, weeklyWeekday: 5, weeklyTarget: 'current' }, 'boss');
    await service.tick(friday);
    const previous = repo.getWeeklyReport(db, 'staff', '2026-08-31')!;
    const next = await app.submitRecord('staff', '2026-09-04', '更正：已完成材料复核');
    app.completeDailyPresentation('staff', app.prepareDailyPresentation('staff', next)); app.confirmReport('staff', next, 'button');
    enqueue(db, 'weekly_report', { reportId: previous.id }, 'lead', 'stale-report');
    await service.tick(friday); await service.tick(friday);
    const current = repo.getWeeklyReport(db, 'staff', '2026-08-31')!;
    expect(current.version).toBe(2);
    expect(getWeeklyInstance(db, 'staff', '2026-08-31').stale).toBe(false);
    expect(client.sendMessage.mock.calls.filter(call => call[1].markdown.content.includes('员工甲的周报'))).toHaveLength(2);
    expect(client.sendMessage.mock.calls.some(call => call[1].markdown.content.includes('已更新'))).toBe(true);
    expect(db.prepare("SELECT state FROM notification_delivery WHERE outbox_id='stale-report'").get()?.state).toBe('cancelled');
    saveWeeklyReason(db, { userId: 'staff', role: 'employee' }, { userId: 'staff', weekId: '2026-08-31', content: '客户材料延迟', expectedVersion: 0 });
    await service.tick(friday);
    expect(repo.getWeeklyReport(db, 'staff', '2026-08-31')?.version).toBe(3);
  });
  it('零日报提醒在补充确认后撤销；角色撤销后反馈不发送', async () => {
    const { db, app, client, service } = setup();
    updateNotificationSettings(db, { weeklyReportEnabled: true, weeklyWeekday: 5, weeklyTarget: 'current' }, 'boss');
    enqueue(db, 'weekly_missing', { ownerId: 'staff', week: '2026-08-31' }, 'lead', 'missing-old');
    await confirm(app);
    const report = await app.generateWeeklyReport('staff', '2026-08-31');
    app.addFeedback(report, '请跟进', null, 'lead');
    db.prepare("UPDATE message_outbox SET next_attempt_at=?").run(friday.toISOString());
    db.prepare("UPDATE app_user SET role='employee' WHERE id='lead'").run();
    await service.flushOutbox(friday);
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(notificationOverview(db).queue.every((row: any) => row.status === 'cancelled')).toBe(true);
  });
  it('反馈已修改时旧revision不发送，最新修订只发一次并标注修订', async () => {
    const { db, app, client, service } = setup();
    await confirm(app);
    const weeklyReportId = await app.generateWeeklyReport('staff', '2026-08-31');
    const actor = { userId: 'lead', role: 'team_lead' as const };
    const first = saveWeeklyFeedback(db, actor, { weeklyReportId, content: '旧意见' }, friday);
    saveWeeklyFeedback(db, actor, { weeklyReportId, feedbackId: first.id, expectedVersion: 1, content: '修订后的意见' }, friday);
    await service.flushOutbox(friday); await service.flushOutbox(friday);
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(client.sendMessage.mock.lastCall?.[1].markdown.content).toContain('反馈修订（第2版）');
    expect(client.sendMessage.mock.lastCall?.[1].markdown.content).toContain('修订后的意见');
    expect(notificationOverview(db).queue.some((row: any) => row.status === 'cancelled')).toBe(true);
  });
  it('风险规则默认不启用，未知不当零；已知低进度仅通知本人及直接经理，重复tick幂等', async () => {
    const { db, client, service } = setup();
    for (const id of ['visit', 'unknown']) {
      repo.insertWorkItem(db, { id, user_id: 'staff', week_id: '2026-08-31', name: id, plan_background: '', created_at: friday.toISOString(), deleted: 0 });
      setItemMetric(db, { userId: 'staff', role: 'employee' }, id, { mode: 'count', total: 5, unit: '家', expectedVersion: 0 });
    }
    repo.insertDailyReport(db, { id: 'risk-source', user_id: 'staff', report_date: '2026-09-04', version: 1, status: 'confirmed', summary: '走访1家',
      progress_json: JSON.stringify([{ workItemRef: 'visit', progressText: '走访1家', progressValue: null, completedCount: 1, progressType: '走访', issues: [], nextActions: [], sourceRecordRefs: [] }]), confirmed_at: friday.toISOString(), created_at: friday.toISOString() });
    await service.tick(friday);
    expect(client.sendMessage).not.toHaveBeenCalled();
    updateNotificationSettings(db, { riskEnabled: true, riskThreshold: 50, riskEarliestWeekday: 5 }, 'boss');
    await service.tick(friday); await service.tick(friday);
    expect(client.sendMessage).toHaveBeenCalledTimes(2);
    expect(new Set(client.sendMessage.mock.calls.map(call => call[0]))).toEqual(new Set(['wx-staff', 'wx-lead']));
    expect(client.sendMessage.mock.calls.every(call => call[1].markdown.content.includes('20%') && !call[1].markdown.content.includes('unknown'))).toBe(true);
  });
  it('风险发送前再算当前事实，进度恢复、改派或日期过期撤销旧提醒', async () => {
    const { db, client, service } = setup();
    updateNotificationSettings(db, { riskEnabled: true }, 'boss');
    repo.insertWorkItem(db, { id: 'done', user_id: 'staff', week_id: '2026-08-31', name: '已完成', plan_background: '', created_at: friday.toISOString(), deleted: 0 });
    setItemMetric(db, { userId: 'staff', role: 'employee' }, 'done', { mode: 'percent', expectedVersion: 0 });
    repo.insertDailyReport(db, { id: 'done-source', user_id: 'staff', report_date: '2026-09-04', version: 1, status: 'confirmed', summary: '完成',
      progress_json: JSON.stringify([{ workItemRef: 'done', progressText: '完成', progressValue: 100, progressType: '其他', issues: [], nextActions: [], sourceRecordRefs: [] }]), confirmed_at: friday.toISOString(), created_at: friday.toISOString() });
    enqueue(db, 'progress_risk', { ownerId: 'staff', workItemId: 'done', date: '2026-09-04', week: '2026-08-31' });
    enqueue(db, 'progress_risk', { ownerId: 'staff', workItemId: 'done', date: '2026-09-03', week: '2026-08-31' }, 'lead', 'risk-expired');
    await service.flushOutbox(friday);
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(notificationOverview(db).queue.every((row: any) => row.status === 'cancelled')).toBe(true);
  });
  it('周报已排队但知识资料撤权后不继续发送链接或旧正文',async()=>{
    const {db,app,client,service}=setup();
    const crm=new CrmStore(db),company=crm.saveCompany({name:'知识关联企业',ownerId:'staff'},'boss');
    repo.createKnowledgeEntry(db,{id:'revoked-doc',kind:'park_material',title:'园区资料',summary:'',content:'测试资料',tags_json:'[]',source_name:'',created_at:friday.toISOString(),updated_at:friday.toISOString()});
    crm.link(company.id,{knowledgeId:'revoked-doc'},'boss');
    await confirm(app);
    const reportId=await app.generateWeeklyReport('staff','2026-08-31');
    enqueue(db,'weekly_report',{reportId},'lead');
    updateNotificationSettings(db,{weeklyReportEnabled:true},'boss');
    db.prepare("UPDATE knowledge_entry SET active=0 WHERE id='revoked-doc'").run();
    await service.flushOutbox(friday);
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(notificationOverview(db).queue[0]).toMatchObject({status:'cancelled'});
    expect(db.prepare('SELECT COUNT(*) AS n FROM access_grant').get()?.n).toBe(0);
  });
});
