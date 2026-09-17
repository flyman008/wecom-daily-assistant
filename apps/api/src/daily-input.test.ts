import { afterEach, describe, expect, it, vi } from 'vitest';
import * as repo from '@wecom/persistence';
import { MockAgent } from '@wecom/agent';
import { DailyAssistantApp } from './app';
import { submitStructuredDaily } from './daily-input';
import { getItemMetric, setItemMetric } from './progress-ledger';

const date = '2026-09-04', week = '2026-08-31', now = new Date('2026-09-05T04:00:00Z');
const owner = { userId: 'staff', role: 'employee' as const }, databases: repo.Db[] = [];
afterEach(() => { databases.splice(0).forEach(db => db.close()); vi.restoreAllMocks(); });
function setup(mode?: 'count' | 'percent') {
  const db = repo.openDb(':memory:'); databases.push(db);
  repo.upsertUser(db, { id: 'staff', name: '员工', role: 'employee' });
  repo.insertWorkItem(db, { id: 'item', user_id: 'staff', week_id: week, name: '合同梳理', plan_background: '三项合同', created_at: now.toISOString(), deleted: 0 });
  if (mode) setItemMetric(db, owner, 'item', mode === 'count'
    ? { mode, total: 3, unit: '项', expectedVersion: 0 }
    : { mode, expectedVersion: 0 });
  const model = new MockAgent(), modelRun = vi.spyOn(model, 'run'), app = new DailyAssistantApp(db, model), submit = vi.spyOn(app, 'submitRecord');
  return { db, app, modelRun, submit };
}
function facts(extra: Record<string, unknown> = {}) {
  return { date, summary: '已核实当日进展', expectedReportId: null, items: [{ workItemRef: 'item', progressText: '合同条款核实情况', progressType: '其他', progressValue: null, ...extra }] };
}
function count(db: repo.Db, table: string): number { return Number(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n); }

describe('结构化填报的进度口径前置门禁', () => {
  it('无metric时拒绝百分比及未知表单，返回先配置提示；不保存来源、草稿或擅自创建metric', async () => {
    const { db, app, submit, modelRun } = setup();
    for (const value of [33, null]) await expect(submitStructuredDaily(app, owner, facts({ progressValue: value }), `missing:${value}`, now))
      .rejects.toMatchObject({ status: 400, message: '请先设置“合同梳理”的进度口径，再填写事项进展' });
    expect(submit).not.toHaveBeenCalled(); expect(modelRun).not.toHaveBeenCalled();
    expect(count(db, 'source_message')).toBe(0); expect(count(db, 'daily_report')).toBe(0); expect(getItemMetric(db, 'item')).toBeUndefined();
  });

  it('完整payload必须先通过事实字段和权限校验，不能因第一个事项无metric漏验后续事项', async () => {
    const { app, submit } = setup();
    const body = facts(); body.items.push({ ...body.items[0], workItemRef: 'outside-person' });
    await expect(submitStructuredDaily(app, owner, body, 'invalid-item', now)).rejects.toMatchObject({ status: 400, message: '事项必须属于本人本周且不能重复' });
    expect(submit).not.toHaveBeenCalled();
  });

  it('计数口径拒绝手填百分比、累计数与对象混填，以及同对象同时完成撤销，且没有部分写入', async () => {
    const { db, app, submit } = setup('count'), before = count(db, 'audit_log');
    for (const extra of [
      { progressValue: 33 }, { progressValue: 33, completedCount: 1 },
      { completedCount: 1, completedKeys: ['合同A'] }, { completedCount: 0, retractedKeys: ['合同A'] },
      { completedKeys: ['合同A'], retractedKeys: ['合同A'] },
    ]) await expect(submitStructuredDaily(app, owner, facts(extra), JSON.stringify(extra), now)).rejects.toMatchObject({ status: 400 });
    expect(submit).not.toHaveBeenCalled(); expect(count(db, 'source_message')).toBe(0); expect(count(db, 'daily_report')).toBe(0);
    expect(count(db, 'audit_log')).toBe(before);
  });

  it('百分比口径拒绝任何有效计数或对象信息，不能静默忽略混填值', async () => {
    const { db, app, submit } = setup('percent');
    for (const extra of [{ completedCount: 0 }, { completedCount: 1, progressValue: 80 }, { completedKeys: ['合同A'] }, { retractedKeys: ['合同A'] }]) {
      await expect(submitStructuredDaily(app, owner, facts(extra), JSON.stringify(extra), now)).rejects.toMatchObject({ status: 400 });
    }
    expect(submit).not.toHaveBeenCalled(); expect(count(db, 'source_message')).toBe(0); expect(count(db, 'daily_report')).toBe(0);
  });

  it('已配置的百分比与累计数准确进入待确认稿；不调用模型、不自动确认', async () => {
    const percent = setup('percent');
    const percentId = await submitStructuredDaily(percent.app, owner, facts({ progressValue: 0 }), 'percent-zero', now);
    const percentReport = repo.getDailyReportById(percent.db, percentId)!;
    expect(percentReport.status).toBe('pending_confirmation'); expect(JSON.parse(percentReport.progress_json!)[0].progressValue).toBe(0);
    const counted = setup('count');
    const countId = await submitStructuredDaily(counted.app, owner, facts({ completedCount: 2 }), 'count-two', now);
    const countReport = repo.getDailyReportById(counted.db, countId)!;
    expect(countReport.status).toBe('pending_confirmation'); expect(JSON.parse(countReport.progress_json!)[0]).toMatchObject({ completedCount: 2, progressValue: 66 });
    expect(percent.modelRun).not.toHaveBeenCalled(); expect(counted.modelRun).not.toHaveBeenCalled();
  });

  it('计数未知仍保留null，不要求虚构0；稳定完成对象可用且按原文留存', async () => {
    const unknown = setup('count');
    const unknownId = await submitStructuredDaily(unknown.app, owner, facts(), 'unknown', now);
    expect(JSON.parse(repo.getDailyReportById(unknown.db, unknownId)!.progress_json!)[0].progressValue).toBeNull();
    const objects = setup('count');
    const objectsId = await submitStructuredDaily(objects.app, owner, facts({ completedKeys: ['合同A', '合同B'] }), 'objects', now);
    expect(JSON.parse(repo.getDailyReportById(objects.db, objectsId)!.progress_json!)[0]).toMatchObject({ completedKeys: ['合同A', '合同B'], progressValue: null });
  });

  it('隐藏控制字符和损坏口径会在submitRecord前400，不产生看似成功的未知稿', async () => {
    const { app, db, submit } = setup('count');
    await expect(submitStructuredDaily(app, owner, facts({ completedKeys: ['合同\u202eA'] }), 'hidden-key', now)).rejects.toMatchObject({ status: 400 });
    db.prepare("UPDATE work_item_metric SET unit='' WHERE work_item_id='item'").run();
    await expect(submitStructuredDaily(app, owner, facts({ completedCount: 2 }), 'broken-metric', now)).rejects.toMatchObject({ status: 400, message: '“合同梳理”的进度口径无效，请先重新设置' });
    expect(submit).not.toHaveBeenCalled(); expect(count(db, 'source_message')).toBe(0);
  });

  it('已成功请求重投仍返回原草稿，不因之后修改口径而生成新版本或误判失败', async () => {
    const { app, db, submit } = setup('percent'), body = facts({ progressValue: 33 });
    const id = await submitStructuredDaily(app, owner, body, 'same-request', now);
    setItemMetric(db, owner, 'item', { mode: 'count', total: 3, unit: '项', expectedVersion: 1 });
    expect(await submitStructuredDaily(app, owner, body, 'same-request', now)).toBe(id);
    expect(submit).toHaveBeenCalledTimes(1); expect(count(db, 'daily_report')).toBe(1);
  });
});
