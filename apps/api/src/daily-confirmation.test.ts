import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockAgent, type Agent, type AgentStructuredResult, type AgentTaskRequest } from '@wecom/agent';
import { getDailyReportById, getDailyUserState, getLatestDailyReport, getWeeklyReportById, insertDailyReport, openDb } from '@wecom/persistence';
import { DailyAssistantApp } from './app';

const user = 'employee-1';
const date = '2026-09-04';
beforeEach(()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-09-05T04:00:00Z'));});
afterEach(()=>vi.useRealTimers());

function setup(agent: Agent = new MockAgent(), path = ':memory:') {
  const db = openDb(path);
  const app = new DailyAssistantApp(db, agent);
  app.ensureUser(user);
  return { db, app };
}

function present(app: DailyAssistantApp, id: string): void {
  app.completeDailyPresentation(user, app.prepareDailyPresentation(user, id));
}

function deferredAgent() {
  const pending: Array<{
    request: AgentTaskRequest;
    resolve: (result: AgentStructuredResult) => void;
    reject: (error: Error) => void;
  }> = [];
  const agent: Agent = { run: (request) => new Promise((resolve, reject) => pending.push({ request, resolve, reject })) };
  return {
    agent, pending,
    async finish(index: number) { pending[index].resolve(await new MockAgent().run(pending[index].request)); },
  };
}

describe('日报快照与正式版事务切换', () => {
  it('修改草稿不覆盖原内容，旧待确认版本不能确认新内容', async () => {
    const { app, db } = setup();
    const first = await app.submitRecord(user, date, '走访A');
    present(app, first);
    const original = getDailyReportById(db, first)!;
    const second = await app.submitRecord(user, date, '更正为电话沟通A');
    expect(second).not.toBe(first);
    expect(getDailyReportById(db, first)).toMatchObject({ summary: original.summary, progress_json: original.progress_json, status: 'superseded' });
    expect(() => app.confirmReport(user, first, 'button')).toThrow('已更新');
    expect(() => app.confirm(user, date, 'explicit_command')).toThrow('已更新');
    expect(() => app.confirmReport(user, second, 'button')).toThrow('尚未完整展示');
    expect(() => db.prepare('UPDATE daily_report SET summary=? WHERE id=?').run('偷偷改稿', second)).toThrow('不可原地覆盖');
    present(app, second);
    expect(app.confirm(user, date, 'explicit_command').id).toBe(second);
  });

  it('新稿待确认期间周报仍引用旧正式版，确认后原子切换且保留旧确认时间', async () => {
    const { app, db } = setup();
    const first = await app.submitRecord(user, date, '走访A');
    present(app, first);
    const confirmedAt = app.confirmReport(user, first, 'button').confirmed_at;
    const second = await app.submitRecord(user, date, '补充跟进B');
    const before = getWeeklyReportById(db, await app.generateWeeklyReport(user, '2026-08-31'))!;
    expect(JSON.parse(before.cited_report_ids_json)).toEqual([first]);
    expect(getDailyReportById(db, first)?.status).toBe('confirmed');
    present(app, second);
    app.confirmReport(user, second, 'button');
    expect(getDailyReportById(db, first)).toMatchObject({ status: 'superseded', confirmed_at: confirmedAt });
    const after = getWeeklyReportById(db, await app.generateWeeklyReport(user, '2026-08-31'))!;
    expect(JSON.parse(after.cited_report_ids_json)).toEqual([second]);
    expect(JSON.parse(getWeeklyReportById(db, before.id)!.cited_report_ids_json)).toEqual([first]);
  });

  it('确认事务失败时旧正式版不失效，命令只保留目标绑定而非成功回执', async () => {
    const { app, db } = setup();
    const first = await app.submitRecord(user, date, '原记录');
    present(app, first);
    app.confirmReport(user, first, 'button');
    const second = await app.submitRecord(user, date, '修改记录');
    present(app, second);
    db.exec(`CREATE TRIGGER test_fail_confirm BEFORE INSERT ON audit_log
      WHEN NEW.action='daily_report.confirmed' BEGIN SELECT RAISE(ABORT, '模拟审计写入失败'); END;`);
    expect(() => app.confirmReport(user, second, 'button', 'click-failed')).toThrow('模拟审计写入失败');
    expect(getDailyReportById(db, first)?.status).toBe('confirmed');
    expect(getDailyReportById(db, second)?.status).toBe('pending_confirmation');
    expect(db.prepare('SELECT daily_report_id, completed_at FROM daily_confirmation_receipt').all())
      .toEqual([{ daily_report_id: second, completed_at: null }]);
  });

  it('重复确认只产生一条审计，同一条文字确认重投不能批准下一版本', async () => {
    const { app, db } = setup();
    const first = await app.submitRecord(user, date, '原记录');
    present(app, first);
    app.confirmDisplayedReport(user, 'explicit_command', 'confirm-msg');
    app.confirmReport(user, first, 'button', 'click-1');
    app.confirmReport(user, first, 'button', 'click-1');
    const second = await app.submitRecord(user, date, '修改记录');
    present(app, second);
    expect(app.confirmDisplayedReport(user, 'explicit_command', 'confirm-msg').id).toBe(first);
    expect(getDailyReportById(db, second)?.status).toBe('pending_confirmation');
    expect(db.prepare("SELECT * FROM audit_log WHERE action='daily_report.confirmed'").all()).toHaveLength(1);
    app.ensureUser('another');
    expect(() => app.confirmReport('another', second, 'button')).toThrow('无权');
    expect(() => app.confirmDisplayedReport('another', 'explicit_command', 'confirm-msg')).toThrow('不一致');
  });

  it('被拒绝的文字确认重投也不能在后来展示的新草稿上生效', async () => {
    const { app, db } = setup();
    expect(() => app.confirmDisplayedReport(user, 'explicit_command', 'no-target')).toThrow('没有已展示');
    const first = await app.submitRecord(user, date, '原记录');
    present(app, first);
    const second = await app.submitRecord(user, date, '修改记录');
    expect(() => app.confirmDisplayedReport(user, 'explicit_command', 'rejected-confirm')).toThrow('已更新');
    present(app, second);
    expect(() => app.confirmDisplayedReport(user, 'explicit_command', 'no-target')).toThrow('没有已展示');
    expect(() => app.confirmDisplayedReport(user, 'explicit_command', 'rejected-confirm')).toThrow('已更新');
    expect(getDailyReportById(db, second)?.status).toBe('pending_confirmation');
    expect(app.confirmDisplayedReport(user, 'explicit_command', 'new-confirm').id).toBe(second);
  });
});

describe('持久化展示、编辑与异步竞态', () => {
  it('重启后恢复跨日修改对象、最近展示及确认消息回执', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'daily-workflow-test-'));
    const database = join(directory, 'poc.sqlite');
    let current = setup(new MockAgent(), database);
    try {
      const id = await current.app.submitRecord(user, '2026-09-03', '前一天记录');
      present(current.app, id);
      current.app.startDailyEdit(user, id);
      current.db.close();
      current = setup(new MockAgent(), database);
      expect(current.app.getPendingDailyEdit(user)).toEqual({ reportId: id, date: '2026-09-03' });
      expect(() => current.app.confirm(user, date, 'explicit_command')).toThrow('核对日期');
      const revised = await current.app.submitRecord(user, '2026-09-03', '更正前一天记录', { editingReportId: id });
      expect(current.app.getPendingDailyEdit(user)).toBeUndefined();
      present(current.app, revised);
      current.app.confirmDisplayedReport(user, 'explicit_command', 'confirm-before-restart');
      current.db.close();
      current = setup(new MockAgent(), database);
      expect(getDailyUserState(current.db, 'poc', user)).toMatchObject({ displayed_report_id: revised, last_confirmed_report_id: revised });
      expect(current.app.confirmDisplayedReport(user, 'explicit_command', 'confirm-before-restart').id).toBe(revised);
    } finally {
      current.db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('网络返回顺序变化不会覆盖最近选择的展示对象', async () => {
    const { app, db } = setup();
    const first = await app.submitRecord(user, '2026-09-03', '前一天');
    const second = await app.submitRecord(user, date, '今天');
    const slow = app.prepareDailyPresentation(user, first);
    const fast = app.prepareDailyPresentation(user, second);
    expect(app.completeDailyPresentation(user, fast)).toBe(true);
    expect(app.completeDailyPresentation(user, slow)).toBe(false);
    expect(getDailyUserState(db, 'poc', user)?.displayed_report_id).toBe(second);
    expect(app.confirmDisplayedReport(user, 'explicit_command').id).toBe(second);
  });

  it('未收到完整展示回执时，即便已生成也不能确认', async () => {
    const { app } = setup();
    const id = await app.submitRecord(user, date, '记录');
    app.prepareDailyPresentation(user, id);
    expect(() => app.confirmReport(user, id, 'button')).toThrow('尚未完整展示');
    expect(() => app.confirmDisplayedReport(user, 'explicit_command')).toThrow('没有已展示');
  });

  it('新请求开始后旧草稿暂不能确认，晚返回的旧模型结果不会覆盖新稿', async () => {
    const controlled = deferredAgent();
    const { app, db } = setup();
    const original = await app.submitRecord(user, date, '最初记录');
    present(app, original);
    const writer = new DailyAssistantApp(db, controlled.agent);
    const first = writer.submitRecord(user, date, '记录A', { messageId: 'async-a' });
    expect(() => app.confirmReport(user, original, 'button')).toThrow('尚未整理完成');
    const second = writer.submitRecord(user, date, '记录B', { messageId: 'async-b' });
    await controlled.finish(1);
    const newest = await second;
    await controlled.finish(0);
    await expect(first).rejects.toThrow('已有更新的工作记录');
    expect(getLatestDailyReport(db, user, date)?.id).toBe(newest);
    expect(getDailyReportById(db, newest)?.summary).toContain('记录A');
    expect(getDailyReportById(db, newest)?.summary).toContain('记录B');
    expect(db.prepare("SELECT process_status FROM source_message WHERE msg_id='async-a'").get()).toEqual({ process_status: 'processed' });
  });

  it('两个独立数据库连接也共享生成序号，不依赖进程内锁', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'daily-workflow-test-'));
    const database = join(directory, 'poc.sqlite');
    const controlled = deferredAgent();
    const first = setup(controlled.agent, database);
    const second = setup(new MockAgent(), database);
    try {
      const slow = first.app.submitRecord(user, date, '先到消息', { messageId: 'slow' });
      const latest = await second.app.submitRecord(user, date, '后到消息', { messageId: 'fast' });
      await controlled.finish(0);
      await expect(slow).rejects.toThrow('已有更新');
      expect(getLatestDailyReport(first.db, user, date)?.id).toBe(latest);
    } finally {
      first.db.close();
      second.db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('失败的旧请求不会把已经成功归档的原消息改回失败', async () => {
    const controlled = deferredAgent();
    const { app, db } = setup(controlled.agent);
    const failed = app.submitRecord(user, date, '原消息', { messageId: 'first' });
    const successful = app.submitRecord(user, date, '新消息', { messageId: 'second' });
    await controlled.finish(1);
    const latest = await successful;
    controlled.pending[0].reject(new Error('旧请求超时'));
    await expect(failed).rejects.toThrow('旧请求超时');
    expect(db.prepare("SELECT process_status, daily_report_id FROM source_message WHERE msg_id='first'").get())
      .toEqual({ process_status: 'processed', daily_report_id: latest });
  });

  it('Agent失败保留编辑状态，重复重试不会并发启动同一消息', async () => {
    const { app, db } = setup();
    const original = await app.submitRecord(user, date, '记录');
    present(app, original);
    app.startDailyEdit(user, original);
    const controlled = deferredAgent();
    const editor = new DailyAssistantApp(db, controlled.agent);
    const first = editor.submitRecord(user, date, '更正', { messageId: 'edit-failed', editingReportId: original });
    controlled.pending[0].reject(new Error('模型失败'));
    await expect(first).rejects.toThrow('模型失败');
    expect(app.getPendingDailyEdit(user)?.reportId).toBe(original);
    const retry = editor.submitRecord(user, date, '重复请求', { messageId: 'edit-failed', editingReportId: original });
    await expect(editor.submitRecord(user, date, '又一次重复', { messageId: 'edit-failed', editingReportId: original })).rejects.toThrow('正在处理中');
    await controlled.finish(1);
    await retry;
    expect(app.getPendingDailyEdit(user)).toBeUndefined();
  });

  it('旧版数据库只新增字段和流程表，既有内容不被改写且必须重新展示', () => {
    const directory = mkdtempSync(join(tmpdir(), 'daily-workflow-test-'));
    const database = join(directory, 'poc.sqlite');
    let current = setup(new MockAgent(), database);
    try {
      insertDailyReport(current.db, {
        id: 'legacy-draft', user_id: user, report_date: date, version: 1, status: 'pending_confirmation',
        summary: '既有原稿', progress_json: '[]', confirmed_at: null, created_at: '2026-09-04T10:00:00Z',
      });
      current.db.exec('ALTER TABLE daily_report DROP COLUMN generation_revision');
      current.db.close();
      current = setup(new MockAgent(), database);
      expect(getDailyReportById(current.db, 'legacy-draft')).toMatchObject({ summary: '既有原稿', generation_revision: 0, status: 'pending_confirmation' });
      expect(() => current.app.confirmReport(user, 'legacy-draft', 'button')).toThrow('尚未完整展示');
      present(current.app, 'legacy-draft');
      expect(current.app.confirmReport(user, 'legacy-draft', 'button').status).toBe('confirmed');
    } finally {
      current.db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
