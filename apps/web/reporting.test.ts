import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

// State-machine tests run the actual shipped JS. This deliberately implements
// only its DOM calls; it does not simulate layout or replace browser QA.
class Element {
  textContent = ''; className = ''; value: string | number = ''; type = ''; href = ''; hidden = false;
  disabled = false; closed = false; removed = false; modal = false; colSpan = 0;
  children: Element[] = []; dataset: Record<string, string> = {}; style: Record<string, string> = {};
  attributes: Record<string, string> = {};
  handlers = new Map<string, Array<(...args: any[]) => unknown>>();
  classes = new Set<string>();
  classList = {
    add: (name: string) => this.classes.add(name), remove: (name: string) => this.classes.delete(name),
    contains: (name: string) => this.classes.has(name),
    toggle: (name: string, force?: boolean) => (force ?? !this.classes.has(name)) ? this.classes.add(name) : this.classes.delete(name),
  };
  constructor(readonly tag: string) {}
  append(...nodes: Element[]) { this.children.push(...nodes); }
  appendChild(node: Element) { this.append(node); }
  replaceChildren(...nodes: Element[]) { this.children = nodes; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  addEventListener(name: string, callback: (...args: any[]) => unknown) { this.handlers.set(name, [...(this.handlers.get(name) ?? []), callback]); }
  focus() {}
  showModal() { this.modal = true; }
  close() { this.closed = true; for (const callback of this.handlers.get('close') ?? []) callback(); }
  remove() { this.removed = true; }
}
const all = (node: Element): Element[] => [node, ...node.children.flatMap(all)];
const text = (node: Element): string => [node.textContent, ...node.children.map(text)].join(' ');
const byTag = (node: Element, tag: string) => all(node).filter(candidate => candidate.tag === tag);
const control = (node: Element, label: string) => {
  const match = all(node).find(candidate => candidate.tag === 'label' && candidate.textContent === label)?.children[0];
  if (!match) throw new Error(`Missing real form control: ${label}`);
  return match;
};
const submit = (form: Element) => form.handlers.get('submit')![0]({ preventDefault() {} }) as Promise<void>;
class FixedDate extends Date {
  constructor(value?: string | number) { super(value ?? '2026-09-05T04:00:00Z'); }
  static now() { return Date.parse('2026-09-05T04:00:00Z'); }
}
interface Request {
  url: string; method: string; headers: Headers; body: Record<string, any> | null;
  respond: (status: number, body: unknown) => void;
}
const week = '2026-08-31';
function setup() {
  const nodes = new Map<string, Element>(), created: Element[] = [], requests: Request[] = [];
  const make = (tag: string) => { const element = new Element(tag); created.push(element); return element; };
  const element = (name: string) => { if (!nodes.has(name)) nodes.set(name, make(name)); return nodes.get(name)!; };
  const body = make('body'), storage = new Map([['assistant_poc_session', 'test-session']]);
  const location = { origin: 'http://unit-test.invalid', hash: '#/records/weekly' };
  const automatic = new Map<string, { status: number; body: unknown }>();
  const context = createContext({
    document: {
      body, getElementById: element, querySelector: element,
      querySelectorAll: (selector: string) => selector === 'dialog' ? created.filter(node => node.tag === 'dialog' && !node.removed) : [],
      createElement: make, createTextNode: (value: string) => { const node = make('text'); node.textContent = value; return node; },
    },
    Node: Element, location, URL, URLSearchParams, Headers, Date: FixedDate, Intl, crypto: { randomUUID },
    history: { replaceState: (_state: unknown, _title: string, hash: string) => { location.hash = hash; } },
    window: { addEventListener() {}, setTimeout() {}, confirm: () => true, __POC_CONFIG__: {} },
    sessionStorage: { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    fetch: (url: string, options: { method?: string; headers: Headers; body?: string }) => new Promise(resolve => {
      const respond = (status: number, value: unknown) => resolve({ status, ok: status >= 200 && status < 300, json: async () => value });
      requests.push({ url, method: options.method ?? 'GET', headers: options.headers, body: options.body ? JSON.parse(options.body) : null, respond });
      const response = automatic.get(new URL(url, location.origin).pathname); if (response) respond(response.status, response.body);
    }),
  });
  for (const filename of ['crm.js', 'workspace.js', 'reporting.js', 'app.js']) {
    let source = readFileSync(new URL(filename, import.meta.url), 'utf8');
    if (filename === 'app.js') { expect(source).toMatch(/route\(\);\s*$/); source = source.replace(/route\(\);\s*$/, ''); }
    runInContext(source, context, { filename });
  }
  const run = <T = unknown>(source: string) => runInContext(source, context) as T;
  const assign = (name: string, value: unknown) => { (context as Record<string, unknown>)[name] = value; };
  const identity = (role = 'employee', view = 'personal', userId = 'employee') => run(`
    WS_SESSION={userId:${JSON.stringify(userId)},role:${JSON.stringify(role)}}; WS_VIEW=${JSON.stringify(view)};
    WS_CONTEXT={me:{id:${JSON.stringify(userId)},name:'测试人员'},weekId:'${week}',canManageTeam:${role !== 'employee'},canAdmin:${role === 'admin'},users:[{id:'employee',name:'员工'},{id:'lead',name:'组长'}]};`);
  identity();
  const modal = () => created.filter(node => node.tag === 'dialog' && !node.removed).at(-1)!;
  return { run, assign, identity, requests, storage, location, element, body, modal, automatic, created };
}
function progress(value: number | null = 20) {
  return { weekId: week, userId: 'employee', dates: Array.from({ length: 7 }, (_, index) => new Date(Date.parse(`${week}T00:00:00Z`) + index * 86400000).toISOString().slice(0, 10)), questions: [], sourceReportIds: ['day-v1'], items: [{
    workItemId: 'item', name: '走访企业', retired: false, metric: { mode: 'count', total: 5, unit: '家', rounding: 'floor', version: 1 }, questions: [],
    days: Array.from({ length: 7 }, (_, index) => ({ date: new Date(Date.parse(`${week}T00:00:00Z`) + index * 86400000).toISOString().slice(0, 10), progressValue: value, completedCount: value == null ? null : value / 20, carried: index > 0, reportId: 'day-v1', reportVersion: 1 })),
  }] };
}
function report(version = 1) {
  return { id: `weekly-v${version}`, user_id: 'employee', user_name: '员工', week_id: week, version, content: `周报版本${version}`, generated_at: '2026-09-05T04:00:00Z', sections_json: '[]', cited_report_ids_json: '["day-v1"]' };
}

describe('周报列表、稳定入口与筛选联动', () => {
  it('老板看到整体与可展开员工列表，排除本人且零日报员工仍可查看', async () => {
    const page = setup(); page.identity('team_lead', 'team', 'lead');
    const load = page.run<Promise<void>>("wsRecords('#/records/weekly?weekId=2026-08-31')");
    expect(page.requests[0].url).toBe(`/api/v1/reporting/weeks?weekId=${week}&view=team`);
    page.requests[0].respond(200, { rows: [
      { userId: 'employee', name: '员工', weekId: week, confirmedDays: 3, report: report(2), instance: { stale: true } },
      { userId: 'employee2', name: '未报员工', weekId: week, confirmedDays: 0, report: null },
      { userId: 'lead', name: '组长', weekId: week, confirmedDays: 0, report: null, instance: { stale: false } },
    ] }); await load;
    const rendered = page.element('app'), tables = byTag(rendered, 'table');
    expect(tables).toHaveLength(0); expect(all(rendered).filter(node=>node.className==='rp-person')).toHaveLength(2); // each employee appears in exactly one of four buckets
    expect(text(rendered)).toContain('团队周报');expect(all(rendered).filter(node=>node.className==='rp-person').map(text).join('')).not.toContain('组长');
    expect(text(rendered)).toContain('事项视角');expect(text(rendered)).toContain('暂无可查看的工作事项');
    expect(text(rendered)).not.toMatch(/已出周报|待重生成|已确认日报|尚未生成周报|缺报/);
    expect([...new Set(byTag(rendered, 'a').filter(node => node.className.split(/\s+/).includes('rp-employee-name')).map(node => node.href))]).toEqual([`#/records/week/employee/${week}`, `#/records/week/employee2/${week}`]);
    expect(byTag(rendered, 'a').some(node => node.href.includes('weekly-v2'))).toBe(false);
  });

  it('从企业穿透后API、tab与再次查询保留企业筛选，同时保留人员和周次', async () => {
    const page = setup(); page.identity('team_lead', 'team', 'lead');
    const search = `companyId=company%2Fone&weekId=${week}&userId=employee`, load = page.run<Promise<void>>(`rpWeeks(${JSON.stringify(search)})`);
    const params = new URL(page.requests[0].url, page.location.origin).searchParams;
    expect(Object.fromEntries(params)).toMatchObject({ companyId: 'company/one', weekId: week, userId: 'employee', view: 'team' });
    page.requests[0].respond(200, { rows: [] }); await load;
    const root = page.element('app');
    for (const link of byTag(root, 'a').filter(node => ['日报', '周报与反馈', '周计划'].includes(node.textContent))) expect(link.href).toContain(`?${search}`);
    control(root, '自然周').value = '2026-09-09';
    await submit(byTag(root, 'form')[0]);
    const next = new URLSearchParams(page.location.hash.split('?')[1]);
    expect(Object.fromEntries(next)).toEqual({ weekId: '2026-09-07', userId: 'employee', companyId: 'company/one' });
    expect(text(root)).toContain('周报详情仍按完整自然周展示');
  });

  it.each(['team_lead', 'dept_head', 'admin'])('兼岗%s可切个人/管理视图，同一身份使用对应后端范围', async role => {
    const page = setup(); page.location.hash = '#/records/weekly';
    page.automatic.set('/api/v1/session', { status: 200, body: { userId: 'lead', role } });
    page.automatic.set('/api/v1/workspace', { status: 200, body: { me: { id: 'lead', name: '兼岗人员' }, users: [{ id: 'lead', name: '兼岗人员' }], canManageTeam: true, canAdmin: role === 'admin' } });
    page.automatic.set('/api/v1/reporting/weeks', { status: 200, body: { rows: [] } });
    for (const view of ['personal', 'team']) {
      page.storage.set('assistant_view_lead', view); await page.run<Promise<void>>('wsRoute()');
      expect(page.requests.at(-1)!.url).toContain(`view=${view}`);
      expect(page.element('workspace-view').hidden).toBe(false);
      expect(text(page.element('workspace-identity'))).toContain(view === 'personal' ? '员工端' : '管理端');
      expect(byTag(page.element('app'), 'select')).toHaveLength(view === 'personal' ? 0 : 1);
    }
  });
});

describe('进度、事实草稿与快照隔离', () => {
  it('环比仅比较两周均已知的同一批人，零基数无Infinity，员工概括不显示进度条',()=>{
    const page=setup();page.identity('dept_head','team','lead');
    page.assign('rows',[{userId:'a',name:'甲',progress:progress(80),previousProgress:progress(40),previousAsOf:'2026-09-06'},
      {userId:'b',name:'乙',progress:progress(100),previousProgress:null}]);
    const root=page.run<Element>(`rpManagerReport(rows,'${week}')`);
    expect(byTag(root,'label').map(text).join(' ')).toContain('周环比');
    expect(byTag(root,'label').map(text).join(' ')).toContain('+2 /+40PP');
    expect(byTag(root,'label').map(text).join(' ')).not.toContain('人可比');
    expect(byTag(root,'progress')).toHaveLength(0);
    expect(page.run("rpDelta(2,0,'')")).toBe('周环比+2');
    expect(page.run("rpDelta(2,null,'')")).toBe('周环比—');
    expect(page.run("rpComparison(2,5,0,5,'')")).toEqual({absolute:'+2',rate:'/+40PP',title:'完成数周环比+2；完成率周环比+40个百分点'});
  });
  it('员工事项默认收起，目标及原因留在摘要；一句话只用已确认进度',()=>{
    const page=setup();page.assign('fixture',progress(80));
    const timeline=page.run<Element>("rpTimeline(fixture,crmDate(),{reasons:[{workItemId:'item',content:'等待企业确认走访时间'}]})");
    expect((byTag(timeline,'details')[0] as any).open).toBe(false);
    expect(text(byTag(timeline,'summary')[0])).toContain('4/5家');
    expect(text(byTag(timeline,'summary')[0])).toContain('等待企业确认走访时间');
    expect(text(page.run<Element>('rpSummary(fixture)'))).toContain('走访企业仍需跟进');
  });
  it('老板按每项80%分档，已完成不重入80档，未知不按0；不同单位不合并',()=>{
    const page=setup();page.identity('dept_head','team','lead');
    const mixed=progress(100);mixed.items.push({...progress(20).items[0],workItemId:'second',metric:{...mixed.items[0].metric,unit:'次'}});
    page.assign('rows',[{userId:'a',name:'甲',progress:progress(100)},{userId:'b',name:'乙',progress:progress(80)},{userId:'c',name:'丙',progress:mixed},{userId:'d',name:'丁',progress:progress(null)}]);
    const root=page.run<Element>(`rpManagerReport(rows,'${week}')`),cards=byTag(root,'label').map(text);
    for(const name of ['全部完成','各项达到80%','仍有事项低于80%','进度待确认']) expect(cards.find(c=>c.trim().startsWith(name))).toContain('1/4');
    expect(cards.filter(c=>c.includes('重点企业完成进度'))).toHaveLength(1);
    expect(cards.filter(c=>c.includes('重点企业完成进度')).some(c=>c.includes('—/5'))).toBe(true);
    expect(cards.filter(c=>c.includes('重点企业完成进度')).join(' ')).not.toMatch(/家|次/);
  });
  it('只显示有内容的进展，不铺空白日期，保留已确认零值与最新累计值', () => {
    const page = setup(), data = progress(0); data.items[0].days[0].progressValue = null; data.items[0].days[0].completedCount = null;
    Object.assign(data.items[0].days[0],{progressText:'联系企业，等待回复'});
    Object.assign(data.items[0].days[1],{progressText:'客户延期，本周累计完成0家'});
    Object.assign(data.items[0].days[2],{progressText:'暂无新进展'});
    page.assign('fixtureProgress', data);
    const timeline = page.run<Element>('rpTimeline(fixtureProgress)');
    expect(byTag(timeline, 'table')).toHaveLength(0);
    const rows = byTag(timeline, 'li');
    expect(rows).toHaveLength(2); expect(text(rows[0])).toContain('联系企业'); expect(byTag(rows[0], 'progress')).toHaveLength(0);
    expect(text(rows[1])).toContain('0%'); expect(text(rows[1])).toContain('0家'); expect(byTag(timeline, 'progress')[0].value).toBe(0);
    expect(text(timeline)).toContain('0/5家'); expect(text(timeline)).not.toContain('暂无新进展');
    expect(text(timeline)).not.toContain('未到日期');expect(text(timeline)).not.toContain('沿用');
  });

  it('老板汇总不显示受限内容，不把本人或未知事项当已完成',()=>{
    const page=setup();page.identity('dept_head','team','lead');
    page.assign('teamRows',[
      {userId:'lead',name:'本人',progress:progress(100)},
      {userId:'employee',name:'员工',weekId:week,confirmedDays:1,report:report(),progress:progress(null),reasons:[{workItemId:'item',content:'等待企业补材料'}]},
      {userId:'restricted',name:'受限员工',restricted:true,progress:progress(100),reasons:[{content:'不可见原因'}]},
    ]);
    const root=page.run<Element>(`rpManagerReport(teamRows,'${week}')`);
    expect(text(root)).toContain('—/5 进度待确认');expect(text(root)).toContain('等待企业补材料');expect(text(root)).not.toContain('不可见原因');
    const cards=byTag(root,'label').map(text);
    expect(cards.find(value=>value.includes('全部完成'))).toContain('0/2');
    expect(cards.find(value=>value.trim().startsWith('进度待确认'))).toContain('2/2');
  });

  it('老板业务统计由事项进度决定，不受周报是否生成影响，也不合并同名负责人事项',()=>{
    const page=setup();page.identity('dept_head','team','lead');
    const rows=[{userId:'a',name:'甲',weekId:week,progress:progress(100),report:null},{userId:'b',name:'乙',weekId:week,progress:progress(20),report:report()}];
    page.assign('businessRows',rows);const first=page.run<Element>(`rpManagerReport(businessRows,'${week}')`);
    expect(all(first).filter(node=>node.className==='rp-business-item')).toHaveLength(2);
    expect(byTag(first,'label').map(text).find(value=>value.includes('重点企业完成进度'))).toContain('6/10 ·60%');
    expect(byTag(first,'label').map(text).find(value=>value.includes('全部完成'))).toContain('1/2 ·50%');
    const taskCard=byTag(first,'label').map(text).find(value=>value.includes('重点企业完成进度'))!;
    expect(taskCard).not.toContain('员工2');
    expect(taskCard).toContain('周环比 数/PP');
    expect(text(first).match(/企业走访 · 员工/g)).toBeNull();
    page.assign('businessRows',rows.map(row=>({...row,report:null,confirmedDays:0,instance:{stale:true}})));
    expect(byTag(page.run<Element>(`rpManagerReport(businessRows,'${week}')`),'label').map(text)).toEqual(byTag(first,'label').map(text));
  });

  it('稳定详情明确区分已发布正文与新确认进度，并保留所有版本入口', async () => {
    const page = setup(), load = page.run<Promise<void>>(`rpWeek('employee','${week}')`);
    page.requests[0].respond(200, { name: '员工', canGenerate: true, canEditReason: true, progress: progress(80), detail: {
      instance: { stale: true }, currentReport: report(1), history: [report(1)], reasons: [],
    } }); await load;
    const root = page.element('app');
    expect(text(root)).toContain('周报版本1'); expect(text(root)).toContain('当前已确认进度（可能晚于已生成周报）');
    expect(text(root)).toContain('80%'); expect(text(root)).toContain('尚未更新');
    expect(byTag(root, 'a').filter(node => node.href === '#/records/weekly/weekly-v1')).toHaveLength(2);
    expect(byTag(root, 'button').some(node => node.textContent === '填写整周分析')).toBe(true);
  });

  it('历史版本只展示API给定的冻结进度与生成时原因，不请求或混入当前事实', async () => {
    const page = setup(); page.assign('unrelatedCurrentProgress', progress(100));
    const load = page.run<Promise<void>>("wsWeeklyDetail('weekly-v1')");
    page.requests[0].respond(200, { report: report(1), companies: [], canFeedback: false, feedback: [], progressSnapshot: progress(20), sourceSnapshot: {
      items: [{ id: 'item', name: '当时的走访计划' }], reasons: [{ workItemId: 'item', content: '生成时的旧原因', version: 1 }],
    } }); await load;
    const root = page.element('app');
    expect(page.requests.map(request => request.url)).toEqual(['/api/v1/workspace/weekly-reports/weekly-v1?view=personal']);
    expect(text(root)).toContain('不可变发布快照'); expect(text(root)).toContain('20%'); expect(text(root)).not.toContain('100%');
    expect(text(root)).toContain('生成时的旧原因'); expect(text(root)).toContain('当时的走访计划');
    expect(byTag(root, 'a').find(node => node.textContent === '← 本周所有版本')?.href).toBe(`#/records/week/employee/${week}`);
  });

  it('表单保留已选事项和0值；提交只保存待确认草稿，带原版本和幂等key，不直接确认', async () => {
    const page = setup();
    const old = { id: 'daily-old', report_date: '2026-09-05', summary: '明确未完成', progress_json: JSON.stringify([{ workItemRef: 'item', progressText: '暂未完成', progressValue: 0, progressType: '走访' }]) };
    page.assign('draftFixture', old); page.assign('detailFixture', { currentReportId: 'daily-old', types: ['走访', '活动', '其他'], items: [{ id: 'item', name: '走访企业', metric: { mode: 'percent' } }] });
    await page.run<Promise<void>>('rpDraftEditor(detailFixture,draftFixture)');
    const dialog = page.modal(), form = byTag(dialog, 'form')[0];
    expect(dialog.modal).toBe(true); expect(control(dialog, '当日事项').value).toBe('true');
    expect(control(dialog, '累计百分比（未知留空）').value).toBe(0); expect(text(dialog)).toContain('不会直接入库');
    const save = submit(form), request = page.requests[0];
    expect(request.method).toBe('POST'); expect(request.url).toBe('/api/v1/reporting/daily?view=personal');
    expect(request.headers.get('Idempotency-Key')).toBeTruthy(); expect(request.headers.get('Authorization')).toBe('Bearer test-session');
    expect(request.body).toMatchObject({ expectedReportId: 'daily-old', summary: '明确未完成', items: [{ workItemRef: 'item', progressValue: 0 }] });
    request.respond(201, { reportId: 'new-pending-draft' }); await save;
    expect(page.location.hash).toBe('#/records/daily/new-pending-draft'); expect(dialog.closed).toBe(true);
    expect(page.requests).toHaveLength(1); expect(page.requests.some(request => request.url.includes('confirm'))).toBe(false);
  });

  it('未知百分比空白仍提交null，不能由前端Number空白变成0', async () => {
    const page = setup(); page.assign('detailFixture', { currentReportId: null, types: ['其他'], items: [{ id: 'item', name: '走访', metric: { mode: 'percent' } }] });
    await page.run<Promise<void>>('rpDraftEditor(detailFixture,null)');
    const dialog = page.modal(); control(dialog, '当日事项').value = 'true'; control(dialog, '当日事实摘要 *').value = '只记录沟通事实'; control(dialog, '当日事实').value = '企业正在评估';
    const saving = submit(byTag(dialog, 'form')[0]);
    expect(page.requests[0].body!.items[0].progressValue).toBeNull();
    page.requests[0].respond(201, { reportId: 'unknown-progress-draft' }); await saving;
  });

  it('未设置口径的事项仅显示设置入口，没有进度输入且不会混入草稿提交', async () => {
    const page = setup(); page.assign('detailFixture', { currentReportId: null, types: ['其他'], items: [
      { id: 'unconfigured', name: '尚未设置口径的事项', metric: null },
      { id: 'configured', name: '已经设置口径的事项', metric: { mode: 'percent' } },
    ] });
    await page.run<Promise<void>>('rpDraftEditor(detailFixture,null)');
    const dialog = page.modal(), fieldsets = byTag(dialog, 'fieldset'), unset = fieldsets[0], configured = fieldsets[1];
    expect(text(unset)).toContain('系统不会猜测口径');
    expect(all(unset).filter(node => ['input', 'textarea', 'select'].includes(node.tag))).toHaveLength(0);
    const setupButton = byTag(unset, 'button').find(node => node.textContent === '设置进度口径'); expect(setupButton).toBeDefined();
    const opening = setupButton!.handlers.get('click')![0]() as Promise<void>;
    expect(page.requests[0]).toMatchObject({ method: 'GET', url: '/api/v1/reporting/metrics/unconfigured?view=personal' });
    page.requests[0].respond(200, { metric: null }); await opening;
    expect(text(page.modal())).toContain('尚未设置口径的事项 · 进度口径'); page.modal().close();
    control(dialog, '当日事实摘要 *').value = '记录已配置事项的实际进度';
    control(configured, '当日事项').value = 'true'; control(configured, '当日事实').value = '已完成20%';
    control(configured, '累计百分比（未知留空）').value = '20';
    const saving = submit(byTag(dialog, 'form')[0]);
    expect(page.requests[1].body!.items).toEqual([{ workItemRef: 'configured', progressText: '已完成20%', progressType: '其他', progressValue: 20 }]);
    page.requests[1].respond(201, { reportId: 'configured-only-draft' }); await saving;
  });

  it('计数草稿保留稳定对象/撤销键，不将对象数在前端冒充累计数或完成率', async () => {
    const page = setup();
    page.assign('detailFixture', { currentReportId: null, types: ['走访'], items: [{ id: 'item', name: '走访', metric: { mode: 'count', total: 5, unit: '家' } }] });
    await page.run<Promise<void>>('rpDraftEditor(detailFixture,null)'); const dialog = page.modal();
    control(dialog, '当日事项').value = 'true'; control(dialog, '当日事实摘要 *').value = '走访企业B，撤销之前误记的A';
    control(dialog, '当日事实').value = '走访B'; control(dialog, '本日完成对象（每行一个稳定名称，与累计数二选一）').value = ' 企业B \n'; control(dialog, '本日撤销完成对象（每行一个）').value = '企业A';
    const saving = submit(byTag(dialog, 'form')[0]);
    expect(page.requests[0].body!.items[0]).toMatchObject({ progressValue: null, completedKeys: ['企业B'], retractedKeys: ['企业A'] });
    expect(page.requests[0].body!.items[0]).not.toHaveProperty('completedCount');
    page.requests[0].respond(201, { reportId: 'count-draft' }); await saving;
  });
});

describe('反馈修订与趋势穿透', () => {
  it.each([false, true])('管理反馈按返回权限开放，只有自己的反馈有修订按钮：canFeedback=%s', async canFeedback => {
    const page = setup(); page.identity('team_lead', 'team', 'lead'); const load = page.run<Promise<void>>("rpVersion('weekly-v1')");
    page.requests[0].respond(200, { report: report(), companies: [], canFeedback, progressSnapshot: null, feedback: [
      { id: 'mine', manager_user_id: 'lead', content: '我的当前反馈', revision: 2, revisions: [{ version: 1, content: '我的历史反馈' }] },
      { id: 'another', manager_user_id: 'admin', content: '另一个领导反馈', revision: 1, revisions: [] },
    ] }); await load;
    const root = page.element('app'), buttons = byTag(root, 'button');
    expect(buttons.filter(node => node.textContent === '修改反馈')).toHaveLength(canFeedback ? 1 : 0);
    expect(buttons.filter(node => node.textContent === '新增管理反馈')).toHaveLength(canFeedback ? 1 : 0);
    expect(text(root)).toContain('我的历史反馈'); expect(text(root)).toContain('历史修订 1');
    expect(text(root).match(/我的当前反馈/g)).toHaveLength(1);
  });

  it('反馈修订请求携带已读revision，失败重试复用modal固定Idempotency-Key', async () => {
    const page = setup(); page.identity('team_lead', 'team', 'lead'); page.assign('reportFixture', report(3));
    page.assign('feedbackFixture', { id: 'feedback-one', content: '原反馈', revision: 4 }); page.run('rpFeedback(reportFixture,feedbackFixture)');
    const dialog = page.modal(), form = byTag(dialog, 'form')[0]; control(dialog, '反馈内容').value = '经沟通后的修订';
    const first = submit(form); expect(page.requests[0]).toMatchObject({ method: 'PUT', url: '/api/v1/reporting/feedback/feedback-one?view=team', body: { weeklyReportId: 'weekly-v3', content: '经沟通后的修订', expectedVersion: 4 } });
    const key = page.requests[0].headers.get('Idempotency-Key'); expect(key).toBeTruthy();
    page.requests[0].respond(503, { error: 'temporary unavailable' }); await first;
    expect(dialog.closed).toBe(false); expect(text(dialog)).toContain('temporary unavailable');
    const retry = submit(form); expect(page.requests[1].headers.get('Idempotency-Key')).toBe(key); expect(page.requests[1].body).toEqual(page.requests[0].body);
    page.requests[1].respond(503, { error: 'temporary unavailable' }); await retry;
    page.run('rpFeedback(reportFixture,null)'); const another = page.modal(); control(another, '反馈内容').value = '新反馈';
    const fresh = submit(byTag(another, 'form')[0]); expect(page.requests[2].method).toBe('POST'); expect(page.requests[2].headers.get('Idempotency-Key')).not.toBe(key);
    expect(page.requests[2].body).not.toHaveProperty('expectedVersion'); page.requests[2].respond(503, { error: 'test only' }); await fresh;
  });

  it('所有趋势数据点进入稳定周入口，未知不画成0且不伪造排名', async () => {
    const page = setup(); page.identity('team_lead', 'team', 'lead'); const load = page.run<Promise<void>>('rpAnalytics()');
    page.requests[0].respond(200, { rule: '仅已知项排行', rows: [{ userId: 'employee', name: '员工', weekId: week, rank: null, average: null, missingDays: ['2026-09-01'], trends: [
      { date: '2026-08-31', value: null }, { date: '2026-09-01', value: 0 }, { date: '2026-09-02', value: 40 },
    ] }] }); await load;
    const root = page.element('app'), points = byTag(root, 'a').filter(node => node.className === 'rp-trend-point');
    expect(points).toHaveLength(3); expect(points.every(point => point.href === `#/records/week/employee/${week}`)).toBe(true);
    expect(points[0].attributes['aria-label']).toContain('未知'); expect(text(points[0])).toContain('?');
    expect(all(points[0]).some(node => node.className === 'rp-trend-unknown')).toBe(true);
    expect(all(points[1]).find(node => node.className === 'rp-trend-bar')?.style.height).toBe('0%');
    expect(text(root)).toContain('数值未齐，不排名'); expect(byTag(root, 'table')).toHaveLength(1);
  });

  it('退出后的迟到周快照不能重新显示旧员工内容', async () => {
    const page = setup(), load = page.run<Promise<void>>("rpVersion('weekly-v1')");
    const rejected = expect(load).rejects.toThrow('页面已切换'); page.run("wsInvalidateIdentity(); app.replaceChildren(el('p','','NEW-IDENTITY-PAGE'))");
    page.requests[0].respond(200, { report: { ...report(), content: 'OLD-PRIVATE-CONTENT' }, companies: [], feedback: [], canFeedback: false }); await rejected;
    expect(text(page.element('app'))).toContain('NEW-IDENTITY-PAGE'); expect(text(page.element('app'))).not.toContain('OLD-PRIVATE-CONTENT');
  });
});
