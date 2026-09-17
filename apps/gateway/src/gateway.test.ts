import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventMessage, TextMessage, WsFrame } from '@wecom/aibot-node-sdk';
import { MockAgent } from '@wecom/agent';
import { getDailyReportById, getLatestDailyReport } from '@wecom/persistence';
import { WeComGateway } from './gateway';
import { loadGatewayConfig } from './config';
import { dailyTaskId } from './daily-card';

vi.mock('@wecom/aibot-node-sdk', async (importOriginal) => ({
  ...await importOriginal<typeof import('@wecom/aibot-node-sdk')>(),
  WSClient: class {
    on = vi.fn();
    replyStream = vi.fn().mockResolvedValue({});
    replyStreamWithCard = vi.fn().mockResolvedValue({});
    sendMessage = vi.fn().mockResolvedValue({});
    updateTemplateCard = vi.fn().mockResolvedValue({});
  },
}));

const instances: WeComGateway[] = [];
const user = 'test-employee';
function setup() {
  const config = loadGatewayConfig({ WECOM_BOT_ID: 'test-only', WECOM_BOT_SECRET: 'test-only' });
  config.databasePath = ':memory:';
  const gateway = new WeComGateway(config, new MockAgent());
  gateway.app.ensureUser(user);
  instances.push(gateway);
  return gateway;
}

function textFrame(text: string, msgid: string): WsFrame<TextMessage> {
  return { headers: { req_id: msgid }, body: { msgid, from: { userid: user }, chattype: 'single', msgtype: 'text', text: { content: text } } } as WsFrame<TextMessage>;
}

function cardFrame(reportId: string, action: string, msgid: string, legacy = false): WsFrame<EventMessage> {
  return { headers: { req_id: msgid }, body: {
    msgid, from: { userid: user }, msgtype: 'event', event: {
      eventtype: 'template_card_event', event_key: action, task_id: legacy ? `daily_${reportId}` : dailyTaskId(reportId),
    },
  } } as WsFrame<EventMessage>;
}

beforeEach(()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-09-05T04:00:00Z'));});
afterEach(() => { for (const gateway of instances.splice(0)) gateway.db.close(); vi.useRealTimers(); });

describe('企微日报确认与持久化编辑接入', () => {
  it('纯文字修改/重整/确认不发卡片；重整不新增原始工作消息',async()=>{
    const gateway=setup();
    await gateway['handleText'](textFrame('走访A','text-original'));
    await gateway['handleText'](textFrame('修改日报：更正为与A电话沟通','text-edit'));
    expect(gateway.db.prepare('SELECT COUNT(*) AS n FROM source_message').get()?.n).toBe(2);
    const previous=getLatestDailyReport(gateway.db,user,'2026-09-05')!;
    await gateway['handleText'](textFrame('重新整理日报','text-reprocess'));
    const current=getLatestDailyReport(gateway.db,user,'2026-09-05')!;
    expect(current.version).toBe(previous.version+1);expect(current.status).toBe('pending_confirmation');
    await gateway['handleText'](textFrame('重新整理日报','text-reprocess'));
    expect(getLatestDailyReport(gateway.db,user,'2026-09-05')?.id).toBe(current.id);
    expect(gateway.db.prepare('SELECT COUNT(*) AS n FROM source_message').get()?.n).toBe(2);
    expect(vi.mocked(gateway.client.replyStream).mock.lastCall?.[2]).toContain('确认日报');
    expect(gateway.client.replyStreamWithCard).not.toHaveBeenCalled();
    expect(gateway.client.updateTemplateCard).not.toHaveBeenCalled();
    expect(vi.mocked(gateway.client.sendMessage).mock.calls.some(call=>call[1].msgtype==='template_card')).toBe(false);
    await gateway['handleText'](textFrame('确认日报','text-confirm'));
    expect(getDailyReportById(gateway.db,current.id)?.status).toBe('confirmed');
  });
  it('生成、修改、拒绝旧卡片、文字确认和重复消息都按展示版本处理', async () => {
    const gateway = setup();
    await gateway['handleText'](textFrame('走访A', 'record-1'));
    const first = gateway.db.prepare('SELECT * FROM daily_report').get() as { id: string; report_date: string };
    await gateway['handleCard'](cardFrame(first.id, 'edit_daily', 'edit-1'));
    expect(gateway.app.getPendingDailyEdit(user)?.reportId).toBe(first.id);
    await gateway['handleText'](textFrame('更正：与A电话沟通', 'record-2'));
    const second = getLatestDailyReport(gateway.db, user, first.report_date)!;
    expect(second.id).not.toBe(first.id);
    expect(gateway.app.getPendingDailyEdit(user)).toBeUndefined();
    await gateway['handleCard'](cardFrame(first.id, 'confirm_daily', 'old-click'));
    expect(getDailyReportById(gateway.db, second.id)?.status).toBe('pending_confirmation');
    expect(vi.mocked(gateway.client.replyStream).mock.lastCall?.[2]).toContain('已更新');
    await gateway['handleText'](textFrame('确认', 'confirm-1'));
    expect(getDailyReportById(gateway.db, second.id)?.status).toBe('confirmed');
    await gateway['handleText'](textFrame('补充跟进B', 'record-3'));
    const third = getLatestDailyReport(gateway.db, user, first.report_date)!;
    await gateway['handleText'](textFrame('确认', 'confirm-1'));
    expect(getDailyReportById(gateway.db, third.id)?.status).toBe('pending_confirmation');
  });

  it('旧协议卡片必须重新展示，发送失败不会解锁确认', async () => {
    const gateway = setup();
    const id = await gateway.app.submitRecord(user, '2026-09-04', '既有草稿');
    await gateway['handleCard'](cardFrame(id, 'confirm_daily', 'legacy', true));
    expect(vi.mocked(gateway.client.replyStream).mock.lastCall?.[2]).toContain('旧卡片已失效');
    vi.mocked(gateway.client.replyStream)
      .mockResolvedValueOnce({} as never)
      .mockRejectedValueOnce(new Error('发送内容失败'));
    await gateway['handleText'](textFrame('我的日报 2026-09-04', 'view-failed'));
    expect(() => gateway.app.confirmReport(user, id, 'button')).toThrow('尚未完整展示');
    await gateway['handleText'](textFrame('我的日报 2026-09-04', 'view-success'));
    await gateway['handleCard'](cardFrame(id, 'confirm_daily', 'new-click'));
    expect(getDailyReportById(gateway.db, id)?.status).toBe('confirmed');
  });
  it('周日开始的修改在周一恢复时清理并明确拒绝，不把修改文字写成新周日报',async()=>{
    vi.setSystemTime(new Date('2026-09-06T12:00:00Z'));
    const gateway=setup();
    await gateway['handleText'](textFrame('周日工作事实','sunday-record'));
    const previous=getLatestDailyReport(gateway.db,user,'2026-09-06')!;
    await gateway['handleCard'](cardFrame(previous.id,'edit_daily','sunday-edit'));
    expect(gateway.app.getPendingDailyEdit(user)?.reportId).toBe(previous.id);
    vi.setSystemTime(new Date('2026-09-07T01:00:00Z'));
    await gateway['handleText'](textFrame('更正周日的数量','monday-resume'));
    expect(vi.mocked(gateway.client.replyStream).mock.lastCall?.[2]).toContain('已跨周');
    expect(gateway.app.getPendingDailyEdit(user)).toBeUndefined();
    expect(getLatestDailyReport(gateway.db,user,'2026-09-07')).toBeUndefined();
    expect(gateway.db.prepare('SELECT COUNT(*) AS n FROM source_message').get()?.n).toBe(1);
    expect(getDailyReportById(gateway.db,previous.id)?.status).toBe('pending_confirmation');
    await gateway['handleCard'](cardFrame(previous.id,'edit_daily','old-edit-click'));
    expect(vi.mocked(gateway.client.replyStream).mock.lastCall?.[2]).toContain('已跨周');
  });
});
