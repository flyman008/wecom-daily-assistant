import { afterEach, describe, expect, it } from 'vitest';
import type { DailyExtractResult, DailyItemProgress } from '@wecom/agent';
import * as repo from '@wecom/persistence';
import type { Db } from '@wecom/persistence';
import { buildProgressFromSources, buildWeeklyProgress, ensureProgressSchema, getItemMetric, normalizeDailyProgress, setItemMetric, type ItemMetric, type ProgressWorkItemContext } from './progress-ledger';

const at = '2026-09-05T04:00:00.000Z', week = '2026-08-31';
const databases: Db[] = [];
const employee = { userId: 'staff', role: 'employee' as const };
function setup() {
  const db = repo.openDb(':memory:'); databases.push(db); ensureProgressSchema(db);
  repo.upsertUser(db, { id: 'staff', name: '员工', role: 'employee' });
  repo.upsertUser(db, { id: 'admin', name: '管理员', role: 'admin' });
  repo.upsertUser(db, { id: 'other', name: '其他员工', role: 'employee' });
  return db;
}
function workItem(db: Db, id = 'visit', total: number | null = 5, owner = 'staff', tenant = 'poc') {
  repo.insertWorkItem(db, { id, tenant_id: tenant, user_id: owner, week_id: week, name: id, plan_background: '', created_at: at, deleted: 0 });
  return total === null ? undefined : setItemMetric(db, { userId: owner, role: 'employee', tenantId: tenant }, id, { mode: 'count', total, unit: '项', expectedVersion: 0 });
}
function entry(id: string, rest: Partial<DailyItemProgress> = {}): DailyItemProgress {
  return { workItemRef: id, progressText: '员工确认的进度事实', progressValue: null, progressType: '其他', issues: [], nextActions: [], sourceRecordRefs: [], ...rest };
}
function daily(db: Db, id: string, date: string, items: DailyItemProgress[], options: { version?: number; status?: 'confirmed' | 'pending_confirmation' | 'superseded'; owner?: string; tenant?: string } = {}) {
  repo.insertDailyReport(db, { id, tenant_id: options.tenant ?? 'poc', user_id: options.owner ?? 'staff', report_date: date, version: options.version ?? 1,
    status: options.status ?? 'confirmed', summary: '已确认事实', progress_json: JSON.stringify(items), confirmed_at: options.status === 'pending_confirmation' ? null : at, created_at: at });
}
function values(db: Db, itemId = 'visit'): Array<number | null> { return buildWeeklyProgress(db, 'staff', week).items.find(item => item.workItemId === itemId)!.days.map(day => day.progressValue); }
function result(item: DailyItemProgress): DailyExtractResult { return { schemaVersion: 1, summary: '事实摘要', items: [item], missingFields: [], riskFlags: [] }; }
function context(mode: 'count' | 'percent' = 'count'): ProgressWorkItemContext[] {
  return [{ id: 'visit', name: '企业走访', planBackground: '', metric: { workItemId: 'visit', mode, total: mode === 'count' ? 3 : null, unit: mode === 'count' ? '家' : '%', rounding: 'floor', version: 1, updatedAt: at } }];
}
function normalize(item: Partial<DailyItemProgress>, text: string, mode: 'count' | 'percent' = 'count') {
  return normalizeDailyProgress(result(entry('visit', { sourceRecordRefs: ['s1'], ...item })), context(mode), [{ id: 's1', text, date: week }]);
}
afterEach(() => databases.splice(0).forEach(db => db.close()));

describe('事项进度目标：显式配置与版本控制', () => {
  it('缺省没有总数，首次显式配置后可按版本更改，保留目标修订和审计', () => {
    const db = setup(); workItem(db, 'visit', null);
    expect(getItemMetric(db, 'visit')).toBeUndefined();
    const first = setItemMetric(db, employee, 'visit', { mode: 'count', total: 3, unit: '家', expectedVersion: 0 });
    expect(first).toMatchObject({ mode: 'count', total: 3, rounding: 'floor', version: 1 });
    expect(() => setItemMetric(db, employee, 'visit', { mode: 'count', total: 5, unit: '家', expectedVersion: 0 })).toThrow('已被修改');
    const next = setItemMetric(db, employee, 'visit', { mode: 'percent', expectedVersion: 1 });
    expect(next).toMatchObject({ mode: 'percent', total: null, unit: '%', version: 2 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM work_item_metric_revision').get()?.n).toBe(2);
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='work_item.metric_updated'").get()?.n).toBe(2);
  });
  it('拒绝零/负数/小数/缺失总数、无单位、额外字段和错误取整规则', () => {
    const db = setup(); workItem(db, 'visit', null);
    for (const total of [undefined, null, 0, -1, 1.5, Infinity]) expect(() => setItemMetric(db, employee, 'visit', { mode: 'count', total, unit: '家', expectedVersion: 0 })).toThrow('总数');
    expect(() => setItemMetric(db, employee, 'visit', { mode: 'count', total: 2, expectedVersion: 0 })).toThrow('单位');
    expect(() => setItemMetric(db, employee, 'visit', { mode: 'percent', total: 100, expectedVersion: 0 })).toThrow('不接受总数');
    expect(() => setItemMetric(db, employee, 'visit', { mode: 'count', total: 2, unit: '家', expectedVersion: 0, userId: 'other' } as never)).toThrow('不支持');
    expect(() => setItemMetric(db, employee, 'visit', { mode: 'percent', expectedVersion: 0, rounding: 'ceil' } as never)).toThrow('取整');
    expect(() => db.prepare('INSERT INTO work_item_metric(tenant_id,work_item_id,mode,total,unit,rounding,version,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run('poc', 'visit', 'count', null, '家', 'floor', 1, at)).toThrow();
  });
  it('仅实际活跃本人可设，管理员代改、角色伪造、只读链接、停用和跨租户均拒绝', () => {
    const db = setup(); workItem(db, 'visit', null);
    const input = { mode: 'percent' as const, expectedVersion: 0 };
    for (const actor of [{ userId: 'admin', role: 'admin' as const }, { ...employee, role: 'admin' as const }, { ...employee, resourceId: 'shared' }, { ...employee, tenantId: 'other' }]) {
      expect(() => setItemMetric(db, actor, 'visit', input)).toThrow('本人');
    }
    db.prepare("UPDATE app_user SET active=0 WHERE id='staff'").run();
    expect(() => setItemMetric(db, employee, 'visit', input)).toThrow('本人');
  });
  it('审计失败回滚目标与修订，支持外层事务', () => {
    const db = setup(); workItem(db, 'visit', null);
    db.exec("CREATE TRIGGER reject_metric_audit BEFORE INSERT ON audit_log WHEN NEW.action='work_item.metric_updated' BEGIN SELECT RAISE(ABORT,'audit failed'); END");
    expect(() => setItemMetric(db, employee, 'visit', { mode: 'percent', expectedVersion: 0 })).toThrow('audit failed');
    expect(getItemMetric(db, 'visit')).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM work_item_metric_revision').get()?.n).toBe(0);
    db.exec('DROP TRIGGER reject_metric_audit');
    db.exec('BEGIN'); setItemMetric(db, employee, 'visit', { mode: 'percent', expectedVersion: 0 }); db.exec('ROLLBACK');
    expect(getItemMetric(db, 'visit')).toBeUndefined();
  });
});

describe('周报原表四事项金样例与确定性全周回放', () => {
  it('原表5家走访/2场活动/3项合同/2场学习，五日累计序列精确匹配并延续至周日', () => {
    const db = setup();
    for (const [id, total] of [['visit', 5], ['activity', 2], ['contract', 3], ['study', 2]] as const) workItem(db, id, total);
    // The source table explicitly contains Monday's 0% cells. These are confirmed
    // zeros, not synthesized from blank narrative cells. Anonymous events below
    // use the corresponding employee-confirmed cumulative count snapshots.
    daily(db, 'mon', '2026-08-31', [entry('visit', { completedKeys: ['A'] }), entry('activity', { completedCount: 0 }), entry('contract', { completedCount: 0 }), entry('study', { completedCount: 0 })]);
    daily(db, 'tue', '2026-09-01', [entry('activity', { completedCount: 1 }), entry('contract', { completedCount: 1 }), entry('study', { completedCount: 1 })]);
    daily(db, 'wed', '2026-09-02', [entry('visit', { completedKeys: ['B', 'C', 'D'] })]);
    daily(db, 'thu', '2026-09-03', [entry('study', { completedCount: 2 })]);
    daily(db, 'fri', '2026-09-04', [entry('activity', { completedCount: 2 }), entry('contract', { completedCount: 2 })]);
    expect(values(db, 'visit')).toEqual([20, 20, 80, 80, 80, 80, 80]);
    expect(values(db, 'activity')).toEqual([0, 50, 50, 50, 100, 100, 100]);
    expect(values(db, 'contract')).toEqual([0, 33, 33, 33, 66, 66, 66]);
    expect(values(db, 'study')).toEqual([0, 50, 50, 100, 100, 100, 100]);
    expect(buildWeeklyProgress(db, 'staff', week).questions).toEqual([]);
  });
  it('未知不等于0，明确零后才为0，未提及延续且保留来源版本', () => {
    const db = setup(); workItem(db);
    daily(db, 'unknown', '2026-08-31', [entry('visit')]);
    daily(db, 'zero', '2026-09-02', [entry('visit', { completedCount: 0 })]);
    daily(db, 'later-unknown', '2026-09-03', [entry('visit')]);
    expect(values(db)).toEqual([null, null, 0, 0, 0, 0, 0]);
    expect(buildWeeklyProgress(db, 'staff', week).items[0].days[4]).toMatchObject({ carried: true, reportId: 'zero', reportVersion: 1 });
  });
  it('同日重复完成键与跨日复述去重；撤销后复读旧完成键不复活旧事实', () => {
    const db = setup(); workItem(db);
    daily(db, 'mon', '2026-08-31', [entry('visit', { completedKeys: ['A', 'A', 'B'] })]);
    daily(db, 'tue', '2026-09-01', [entry('visit', { completedKeys: ['A', 'B'] })]);
    daily(db, 'wed', '2026-09-02', [entry('visit', { retractedKeys: ['A', 'A'] })]);
    daily(db, 'thu', '2026-09-03', [entry('visit', { completedKeys: ['A', 'B'] })]);
    expect(values(db)).toEqual([40, 40, 20, 20, 20, 20, 20]);
    expect(buildWeeklyProgress(db, 'staff', week).items[0].days[3].completedKeys).toEqual(['B']);
  });
  it('未知撤销键不能凭空扣减；同一键既完成又撤销要求核对', () => {
    const db = setup(); workItem(db);
    daily(db, 'mon', week, [entry('visit', { retractedKeys: ['A'] })]);
    daily(db, 'tue', '2026-09-01', [entry('visit', { completedKeys: ['A'], retractedKeys: ['A'] })]);
    expect(values(db)).toEqual(Array(7).fill(null));
    expect(buildWeeklyProgress(db, 'staff', week).questions.join(' ')).toMatch(/没有已确认完成事实.*同时新增和撤销/u);
  });
  it('累计快照每次替换不重复加，不能和匿名完成键混算', () => {
    const db = setup(); workItem(db);
    daily(db, 'mon', week, [entry('visit', { completedCount: 2 })]);
    daily(db, 'tue', '2026-09-01', [entry('visit', { completedCount: 2 })]);
    daily(db, 'wed', '2026-09-02', [entry('visit', { completedKeys: ['A'] })]);
    daily(db, 'thu', '2026-09-03', [entry('visit', { completedCount: 1 })]);
    expect(values(db)).toEqual([40, 40, 40, 20, 20, 20, 20]);
    expect(buildWeeklyProgress(db, 'staff', week).questions.join('')).toContain('避免与完成键重复计数');
  });
  it('已确认日报更正后重算所有后续天，旧版本与未确认新草稿不计入', () => {
    const db = setup(); workItem(db);
    daily(db, 'old-mon', week, [entry('visit', { completedKeys: ['A', 'B'] })]);
    daily(db, 'wed', '2026-09-02', [entry('visit', { completedKeys: ['C'] })]);
    expect(values(db)).toEqual([40, 40, 60, 60, 60, 60, 60]);
    daily(db, 'pending', week, [entry('visit', { completedCount: 5 })], { version: 2, status: 'pending_confirmation' });
    expect(values(db)[0]).toBe(40);
    daily(db, 'corrected', week, [entry('visit', { completedKeys: ['A'] })], { version: 3 });
    expect(values(db)).toEqual([20, 20, 40, 40, 40, 40, 40]);
    expect(buildWeeklyProgress(db, 'staff', week).sourceReportIds).toEqual(['corrected', 'wed']);
  });
  it('百分比是可下降的累计快照；没有该事项的日期延续上一值', () => {
    const db = setup(); workItem(db, 'visit', null); setItemMetric(db, employee, 'visit', { mode: 'percent', expectedVersion: 0 });
    daily(db, 'mon', week, [entry('visit', { progressValue: 80 })]);
    daily(db, 'wed', '2026-09-02', [entry('visit', { progressValue: 20 })]);
    daily(db, 'fri', '2026-09-04', [entry('visit', { progressValue: 0 })]);
    expect(values(db)).toEqual([80, 80, 20, 20, 0, 0, 0]);
  });
  it('默认向下取整且可切四舍五入，纯函数冻结旧目标与日报后不受当前配置改变影响', () => {
    const db = setup(); const metric = workItem(db, 'visit', 3)!;
    daily(db, 'mon', week, [entry('visit', { completedCount: 2 })]);
    const frozenItems = [repo.getWorkItem(db, 'visit')!], frozenReports = repo.listDailyReportsInRange(db, 'staff', week, '2026-09-06');
    const previous = buildProgressFromSources('staff', week, frozenItems, [metric], frozenReports);
    setItemMetric(db, employee, 'visit', { mode: 'count', total: 3, unit: '项', rounding: 'round', expectedVersion: 1 });
    expect(values(db)[0]).toBe(67);
    expect(buildProgressFromSources('staff', week, frozenItems, [metric], frozenReports)).toEqual(previous);
    expect(previous.items[0].days[0].progressValue).toBe(66);
  });
  it('计数不能由模型百分比倒推；无目标与重复事项均返回追问而非默认0', () => {
    const db = setup(); workItem(db); workItem(db, 'unconfigured', null);
    daily(db, 'mon', week, [entry('visit', { progressValue: 20 }), entry('unconfigured', { completedCount: 1 })]);
    daily(db, 'tue', '2026-09-01', [entry('visit', { completedCount: 1 }), entry('visit', { completedCount: 2 })]);
    expect(values(db)).toEqual(Array(7).fill(null));
    expect(buildWeeklyProgress(db, 'staff', week).questions.join('')).toMatch(/倒推|配置|重复事项/);
  });
  it('跨租户/跨人/跨周报告和事项引用不产生进度，退役事项保留历史且不能改目标', () => {
    const db = setup(); workItem(db); workItem(db, 'other-item', 5, 'other');
    db.prepare('INSERT INTO tenant(id,name,created_at) VALUES(?,?,?)').run('foreign', '其他企业', at);
    repo.upsertUser(db, { id: 'foreign-user', tenant_id: 'foreign' }); workItem(db, 'foreign-item', 5, 'foreign-user', 'foreign');
    daily(db, 'other-daily', week, [entry('visit', { completedCount: 5 })], { owner: 'other' });
    daily(db, 'foreign-daily', week, [entry('visit', { completedCount: 5 })], { owner: 'foreign-user', tenant: 'foreign' });
    daily(db, 'my-daily', week, [entry('visit', { completedCount: 1 }), entry('foreign-item', { completedCount: 5 })]);
    daily(db, 'wrong-week', '2026-08-24', [entry('visit', { completedCount: 5 })]);
    expect(values(db)).toEqual(Array(7).fill(20));
    expect(() => buildWeeklyProgress(db, 'staff', week, 'foreign')).toThrow('不属于');
    expect(getItemMetric(db, 'visit', 'foreign')).toBeUndefined();
    repo.deleteWorkItem(db, repo.getWorkItem(db, 'visit')!, 1, 'staff', at);
    expect(buildWeeklyProgress(db, 'staff', week).items[0]).toMatchObject({ retired: true });
    expect(values(db)[0]).toBe(20);
    expect(() => setItemMetric(db, employee, 'visit', { mode: 'percent', expectedVersion: 1 })).toThrow('退役');
  });
  it('真实周一、有效日历及重复调用稳定，回放不写业务或流水', () => {
    const db = setup(); workItem(db); daily(db, 'mon', week, [entry('visit', { completedCount: 2 })]);
    for (const invalid of ['2026-09-01', '2026-02-30', 'bad']) expect(() => buildWeeklyProgress(db, 'staff', invalid)).toThrow('weekId');
    const changes = db.prepare('SELECT total_changes() AS n').get()?.n;
    const one = buildWeeklyProgress(db, 'staff', week), two = buildWeeklyProgress(db, 'staff', week);
    expect(two).toEqual(one); expect(db.prepare('SELECT total_changes() AS n').get()?.n).toBe(changes);
  });
});

describe('模型进度归一：有事实才能数字化，不替用户补完成键', () => {
  it('旧版长事项名和分句累计数可按四个独立段落核验',()=>{
    const names=['企业走访','开展活动','合同梳理','业务学习'],totals=[5,2,3,2],units=['家','场','项','场'];
    const targets=names.map((name,i)=>({...context()[0],id:String(i),name:`${name}，计划完成${totals[i]}${units[i]}`,metric:{...context()[0].metric!,total:totals[i],unit:units[i]}}));
    const source=[{id:'s',date:week,text:'企业走访：走访甲企业，了解扩租需求。已约定提供资料。本周累计走访1家。\n\n开展活动：开展政策交流，乙企业参加。本周累计开展1场活动。\n\n合同梳理：丙企业合同已核对；丁企业付款条款待确认，暂不算完成。本周累计完成1项合同梳理。\n\n业务学习：参加政策学习，整理企业常问问题。本周累计学习1场。'}];
    const input={...result(entry('0')),items:names.map((name,i)=>entry(String(i),{completedCount:1,sourceRecordRefs:['s']}))};
    const output=normalizeDailyProgress(input,targets,source);
    expect(output.items.map(item=>item.progressValue)).toEqual([20,50,33,50]);expect(output.missingFields).toEqual([]);
    const omitted={...input,items:input.items.map(item=>({...item,completedCount:undefined,completedKeys:['不应采信的模型对象']}))};
    const recovered=normalizeDailyProgress(omitted,targets,source);
    expect(recovered.items.map(item=>item.progressValue)).toEqual([20,50,33,50]);
    expect(recovered.items.every(item=>!item.completedKeys)).toBe(true);
    const wrong={...input,items:[{...input.items[0],completedCount:2}]};
    expect(normalizeDailyProgress(wrong,targets,[{...source[0],text:source[0].text.replace('累计开展1场','累计开展2场')}]).items[0].completedCount).toBeUndefined();
  });
  it('未明确百分比时null，模型默认0被移除；原文明示0%可保留', () => {
    expect(normalize({ progressValue: null }, '企业走访有新情况', 'percent').items[0].progressValue).toBeNull();
    const guessed = normalize({ progressValue: 0 }, '企业走访有新情况', 'percent');
    expect(guessed.items[0].progressValue).toBeNull(); expect(guessed.missingFields.join('')).toContain('未知不记为0');
    expect(normalize({ progressValue: 0 }, '企业走访目前0%', 'percent').items[0].progressValue).toBe(0);
  });
  it('原文明确累计数由服务端算百分比，不能把当日1家当累计1家', () => {
    const verified = normalize({ completedCount: 1, progressValue: 99 }, '企业走访累计已完成1家');
    expect(verified.items[0]).toMatchObject({ completedCount: 1, progressValue: 33 });
    const ambiguous = normalize({ completedCount: 1 }, '今天走访1家');
    expect(ambiguous.items[0].completedCount).toBeUndefined(); expect(ambiguous.missingFields.join('')).toContain('当日新增');
    expect(normalize({ completedCount: 0 }, '企业走访尚未开始').items[0]).toMatchObject({ completedCount: 0, progressValue: 0 });
  });
  it('真实完成对象原名可用；编造键、数字序号、局部字符串和否定事实不接受', () => {
    expect(normalize({ completedKeys: ['A'] }, '走访1家，是A').items[0].completedKeys).toEqual(['A']);
    for (const [key, text] of [['B', '走访1家，是A'], ['1', '走访1家，是A'], ['A', '已完成走访AB'], ['企业A', '已完成走访企业AB'], ['A', '尚未完成A企业走访'], ['A', '计划完成A企业走访']]) {
      const normalized = normalize({ completedKeys: [key] }, text);
      expect(normalized.items[0].completedKeys).toBeUndefined(); expect(normalized.missingFields.length).toBeGreaterThan(0);
    }
    expect(normalize({ retractedKeys: ['A'] }, '撤销A的走访完成记录').items[0].retractedKeys).toEqual(['A']);
  });
  it('计划、否定、假设或目标数字不能伪装成已完成进度', () => {
    for (const text of ['计划累计完成2家', '累计未完成2家', '假设累计完成2家']) expect(normalize({ completedCount: 2 }, text).items[0].completedCount).toBeUndefined();
    for (const text of ['下周达到80%', '目标80%', '准备完成80%']) expect(normalize({ progressValue: 80 }, text, 'percent').items[0].progressValue).toBeNull();
  });
  it('百分比上下限、增量、否定、近似值和小数尾数不能当成精确累计快照', () => {
    for (const text of ['尚未达到80%', '没有完成80%', '不到80%', '不是80%', '大约80%', '超过80%', '比昨天增加80%', '下降80%', '80%～90%']) {
      expect(normalize({ progressValue: 80 }, text, 'percent').items[0].progressValue).toBeNull();
    }
    expect(normalize({ progressValue: 1 }, '目前完成11.1%', 'percent').items[0].progressValue).toBeNull();
    expect(normalize({ progressValue: 1 }, '目前完成-1%', 'percent').items[0].progressValue).toBeNull();
    expect(normalize({ progressValue: 11.1 }, '目前完成11.1%', 'percent').items[0].progressValue).toBe(11.1);
    expect(normalize({ completedCount: 2 }, '累计完成超过2家').items[0].completedCount).toBeUndefined();
    expect(normalize({ completedCount: 2 }, '累计完成-2家').items[0].completedCount).toBeUndefined();
  });
  it('事项不明确、缺少目标或引用伪造source均需追问；不自动选第一个事项', () => {
    const unknown = normalize({ workItemRef: 'outside', completedCount: 1 }, '累计完成1家');
    expect(unknown.items).toEqual([]); expect(unknown.missingFields.length).toBeGreaterThan(0);
    const noMetric = normalizeDailyProgress(result(entry('visit', { completedCount: 1 })), [{ id: 'visit', name: '走访', planBackground: '' }], []);
    expect(noMetric.items[0].completedCount).toBeUndefined(); expect(noMetric.missingFields.join('')).toContain('总数');
    const forged = normalize({ sourceRecordRefs: ['not-provided'], progressValue: 20 }, '目前20%', 'percent');
    expect(forged.items[0].progressValue).toBeNull(); expect(forged.missingFields.join('')).toContain('未知原始记录');
  });
  it('只有显式structured入口可使用本人填表数值，仍拒绝未知引用、无效类型与混合口径', () => {
    const manual = normalizeDailyProgress(result(entry('visit', { completedCount: 2, progressValue: null })), context(), [], { structured: true });
    expect(manual.items[0]).toMatchObject({ completedCount: 2, progressValue: 66 });
    const forged = normalizeDailyProgress(result(entry('visit', { completedCount: 2, sourceRecordRefs: ['invented'] })), context(), [], { structured: true });
    expect(forged.items[0].completedCount).toBeUndefined();
    for (const invalid of [{ completedCount: -1 }, { completedCount: 1.2 }, { completedCount: 1, completedKeys: ['A'] }, { completedKeys: ['A'], retractedKeys: ['A'] }]) {
      const output = normalizeDailyProgress(result(entry('visit', invalid)), context(), [], { structured: true });
      expect(output.items[0].completedCount).toBeUndefined(); expect(output.items[0].completedKeys).toBeUndefined(); expect(output.missingFields.length).toBeGreaterThan(0);
    }
  });
  it('多事项共用同条原文时数字必须属于明确事项，不能借其他事项原文补数', () => {
    const targets = context('percent');
    targets.push({ ...targets[0], id: 'contract', name: '合同梳理', metric: { ...targets[0].metric!, workItemId: 'contract' } });
    const source = [{ id: 's1', text: '企业走访目前20%；合同梳理目前80%', date: week }];
    const wrong = normalizeDailyProgress(result(entry('visit', { progressValue: 80, sourceRecordRefs: ['s1'] })), targets, source);
    expect(wrong.items[0].progressValue).toBeNull();
    const correct = normalizeDailyProgress(result(entry('visit', { progressValue: 20, sourceRecordRefs: ['s1'] })), targets, source);
    expect(correct.items[0].progressValue).toBe(20);
    const ambiguous = normalizeDailyProgress(result(entry('visit', { progressValue: 20, sourceRecordRefs: ['s1'] })), targets, [{ ...source[0], text: '目前完成20%' }]);
    expect(ambiguous.items[0].progressValue).toBeNull(); expect(ambiguous.missingFields.join('')).toContain('明确');
  });
  it('多事项中拜访同义词能定位走访，未来或否定拜访不能记完成',()=>{
    const targets=context();targets.push({...targets[0],id:'contract',name:'合同梳理',metric:{...targets[0].metric!,workItemId:'contract'}});
    const claim=result(entry('visit',{completedKeys:['示例甲信息科技'],sourceRecordRefs:['s1']}));
    const verified=normalizeDailyProgress(claim,targets,[{id:'s1',text:'今天拜访示例甲信息科技，企业提出机房建设需求。',date:week}]);
    expect(verified.items[0].completedKeys).toEqual(['示例甲信息科技']);expect(verified.missingFields).toEqual([]);
    for(const text of ['明天拜访示例甲信息科技','今天没有拜访示例甲信息科技']) {
      expect(normalizeDailyProgress(claim,targets,[{id:'s1',text,date:week}]).items[0].completedKeys).toBeUndefined();
    }
  });
});
