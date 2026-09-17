import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

describe('登录页视觉状态', () => {
  it('没有错误内容时不显示空白错误框', () => {
    const css = readFileSync(new URL('style.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.error:empty\s*\{\s*display:\s*none;\s*\}/u);
  });
});

// These are state-machine tests, not a browser emulation or a layout test. The
// actual shipped JavaScript runs against only the DOM methods used below.
class FakeElement {
  textContent = '';
  children: FakeElement[] = [];
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  handlers = new Map<string, Array<(...args: any[]) => unknown>>();
  classes = new Set<string>();
  closed = false;
  removed = false;
  classList = {
    add: (value: string) => this.classes.add(value),
    remove: (value: string) => this.classes.delete(value),
    contains: (value: string) => this.classes.has(value),
    toggle: (value: string) => this.classes.has(value) ? this.classes.delete(value) : this.classes.add(value),
  };
  constructor(readonly tag: string) {}
  append(...nodes: FakeElement[]) { this.children.push(...nodes); }
  appendChild(node: FakeElement) { this.append(node); }
  replaceChildren(...nodes: FakeElement[]) { this.children = nodes; }
  setAttribute() {}
  focus() {}
  addEventListener(kind: string, callback: (...args: any[]) => unknown) {
    this.handlers.set(kind, [...(this.handlers.get(kind) ?? []), callback]);
  }
  close() { this.closed = true; for (const callback of this.handlers.get('close') ?? []) callback(); }
  remove() { this.removed = true; }
}
function textOf(node: FakeElement): string { return [node.textContent, ...node.children.map(textOf)].join(' '); }
function descendants(node: FakeElement): FakeElement[] { return [node, ...node.children.flatMap(descendants)]; }

function setup() {
  const nodes = new Map<string, FakeElement>(), created: FakeElement[] = [];
  const make = (tag: string) => { const node = new FakeElement(tag); created.push(node); return node; };
  const element = (id: string) => { if (!nodes.has(id)) nodes.set(id, make(id)); return nodes.get(id)!; };
  const document = {
    body: make('body'), getElementById: element, querySelector: element,
    querySelectorAll: (selector: string) => selector === 'dialog' ? created.filter((node) => node.tag === 'dialog' && !node.removed) : [],
    createElement: make, createTextNode: (text: string) => { const node = make('text'); node.textContent = text; return node; },
  };
  const storage = new Map([['assistant_poc_session', 'old-test-identity']]);
  const requests: Array<{ url: string; headers: Headers; respond: (status: number, body: unknown) => void }> = [];
  const location = { origin: 'http://isolated.example.test', hash: '#/records/daily/report' };
  const context = createContext({
    document, Node: FakeElement, location, URL, URLSearchParams, Headers, Intl, Date,
    history: { replaceState: (_state: unknown, _title: string, hash: string) => { location.hash = hash; } },
    window: { addEventListener() {}, setTimeout() {}, __POC_CONFIG__: {} },
    sessionStorage: { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    fetch: (url: string, options: { headers: Headers }) => new Promise((resolve) => {
      requests.push({ url, headers: options.headers, respond: (status, body) => resolve({ status, ok: status >= 200 && status < 300, json: async () => body }) });
    }),
  });
  for (const filename of ['crm.js', 'workspace.js', 'app.js']) {
    let source = readFileSync(new URL(filename, import.meta.url), 'utf8');
    if (filename === 'app.js') {
      // Suppress only automatic page bootstrap; individual handlers/functions
      // below are unchanged and are invoked explicitly by each test.
      expect(source).toMatch(/route\(\);\s*$/);
      source = source.replace(/route\(\);\s*$/, '');
    }
    runInContext(source, context, { filename });
  }
  const run = <T = unknown>(source: string): T => runInContext(source, context) as T;
  const newIdentity = () => run(`wsInvalidateIdentity(); sessionStorage.setItem(TOKEN_KEY,'new-test-identity');
    WS_SESSION={userId:'new-person',role:'employee'};WS_CONTEXT={me:{id:'new-person'},users:[]};
    app.replaceChildren(el('p','','NEW-IDENTITY-PAGE'));`);
  const state = () => run<{ session: { userId: string } | null; context: unknown; activation: unknown; view: string; run: number }>('({session:WS_SESSION,context:WS_CONTEXT,activation:WS_ACTIVATION,view:WS_VIEW,run:WS_ROUTE_RUN})');
  return { element, document, make, storage, requests, run, state, newIdentity, location };
}

describe('工作台登录态与迟到响应隔离', () => {
  it('退出在首个await前清空身份和弹层，旧日报200不能重新替换登录页', async () => {
    const page = setup();
    page.run("WS_SESSION={userId:'old'};WS_CONTEXT={me:{id:'old'}};WS_ACTIVATION={code:'mock-code'};WS_VIEW='team'");
    const dialog = page.make('dialog');
    const daily = page.run<Promise<unknown>>("wsDailyDetail('report')");
    const rejected = expect(daily).rejects.toThrow('页面已切换');
    const logout = page.element('logout').handlers.get('click')![0]() as Promise<void>;
    expect(page.state()).toMatchObject({ session: null, context: null, activation: null, view: 'personal' });
    expect(dialog.closed && dialog.removed).toBe(true);
    expect(page.requests[1].url).toBe('/api/v1/auth/logout');
    page.requests[1].respond(200, { ok: true });
    await logout;
    expect(page.storage.has('assistant_poc_session')).toBe(false);
    expect(textOf(page.element('app'))).toContain('访问码入口仅供后台管理员');
    page.requests[0].respond(200, { report: { user_name: '旧人员', report_date: '2026-09-04', status: 'confirmed', version: 1,
      summary: 'PRIVATE-OLD-DAILY', progress_json: '[]' }, companies: [], sources: [], workItems: [] });
    await rejected;
    expect(textOf(page.element('app'))).not.toContain('PRIVATE-OLD-DAILY');
    expect(textOf(page.element('app'))).toContain('访问码入口仅供后台管理员');
  });

  it('旧身份普通请求的迟到401不能清掉新token、上下文或页面', async () => {
    const page = setup();
    const old = page.run<Promise<unknown>>("fetchJson('/api/v1/workspace/records')");
    const rejected = expect(old).rejects.toThrow('页面已切换');
    expect(page.requests[0].headers.get('authorization')).toBe('Bearer old-test-identity');
    page.newIdentity();
    const currentRun = page.state().run;
    page.requests[0].respond(401, { error: 'old_session_expired' });
    await rejected;
    expect(page.storage.get('assistant_poc_session')).toBe('new-test-identity');
    expect(page.state()).toMatchObject({ session: { userId: 'new-person' }, run: currentRun });
    expect(textOf(page.element('app'))).toBe(' NEW-IDENTITY-PAGE');
  });

  it('当前身份401正常清token与所有身份状态并显示登录', async () => {
    const page = setup();
    page.newIdentity();
    const dialog = page.make('dialog');
    const response = page.run<Promise<unknown>>("fetchJson('/api/v1/session')");
    const rejected = expect(response).rejects.toThrow('UNAUTHORIZED');
    page.requests[0].respond(401, { error: 'session_expired' });
    await rejected;
    expect(page.storage.has('assistant_poc_session')).toBe(false);
    expect(page.state()).toMatchObject({ session: null, context: null, activation: null });
    expect(dialog.closed && dialog.removed).toBe(true);
    expect(textOf(page.element('app'))).toContain('登录已过期');
  });

  it('管理员登录401保留原表单并显示访问码错误，不被通用401重绘吞掉', async () => {
    const page = setup();
    page.storage.delete('assistant_poc_session');
    page.run('showLogin()');
    const form = page.element('app').children[0];
    Object.assign(form.children.find((node) => node.tag === 'input')!, { value: 'invalid-test-code' });
    const submission = form.handlers.get('submit')![0]({ preventDefault() {} }) as Promise<void>;
    expect(page.requests[0].url).toBe('/api/v1/auth/login');
    page.requests[0].respond(401, { error: 'invalid_access_code' });
    await submission;
    expect(page.element('app').children[0]).toBe(form);
    expect(textOf(form)).toContain('访问码不正确');
    expect(page.storage.has('assistant_poc_session')).toBe(false);
  });

  it.each(['portal', 'access'])('旧%s授权兑换迟到失败也不能由外层catch覆盖新身份', async (entry) => {
    const page = setup();
    page.location.hash = `#/${entry}/old-grant`;
    const old = page.run<Promise<unknown>>('wsRoute()');
    expect(page.requests[0].url).toBe(`/api/v1/${entry === 'portal' ? 'portal-grants' : 'access-grants'}/exchange`);
    page.newIdentity();
    const currentRun = page.state().run;
    page.requests[0].respond(401, { error: 'old_grant_expired' });
    await old;
    expect(page.storage.get('assistant_poc_session')).toBe('new-test-identity');
    expect(page.state()).toMatchObject({ session: { userId: 'new-person' }, run: currentRun });
    expect(textOf(page.element('app'))).toBe(' NEW-IDENTITY-PAGE');
  });

  it('旧退出请求迟到时，其finally不能登出期间建立的新身份', async () => {
    const page = setup();
    const logout = page.element('logout').handlers.get('click')![0]() as Promise<void>;
    page.newIdentity();
    const currentRun = page.state().run;
    page.requests[0].respond(200, { ok: true });
    await logout;
    expect(page.storage.get('assistant_poc_session')).toBe('new-test-identity');
    expect(page.state()).toMatchObject({ session: { userId: 'new-person' }, run: currentRun });
    expect(textOf(page.element('app'))).toBe(' NEW-IDENTITY-PAGE');
  });
});

describe('知识管理统一列表与单一分类入口', () => {
  it.each([true, false])('关联资料区分当前授权内容与管理员历史快照：current=%s', async (current) => {
    const page = setup();
    const load = page.run<Promise<void>>("wsCompanyDetail('company-one','knowledge')");
    page.requests[0].respond(200, { company: { id:'company-one', name:'示例企业', ownerId:'e001', ownerName:'示例人员' }, permissions:{},
      links:[{ snapshot_json:JSON.stringify({ title:'园区指南', version:current?2:1, content:'授权内容' }),
        current_version:2, historical_version:1, current_active:1, content_view:current?'current':'snapshot', created_at:'2026-09-05T00:00:00Z' }] });
    page.requests[1].respond(200, { users:[], stages:[] });
    await load;
    const rendered = textOf(page.element('app'));
    expect(rendered).toContain(current?'查看当前资料':'查看历史快照');
    expect(rendered).not.toContain(current?'查看历史快照':'查看当前资料');
    expect(rendered).toContain('v1');
    expect(rendered).toContain('v2');
  });
  const templates = [
    { id: 'daily-v2', kind: 'daily', name: '当前日报模板', version: 2, active: 1, content: '{"fields":["工作事项","当日进展"]}', created_at: '2026-09-05T00:00:00Z' },
    { id: 'daily-v1', kind: 'daily', name: '历史日报模板', version: 1, active: 0, content: '{"fields":["工作事项"]}', created_at: '2026-09-04T00:00:00Z' },
    { id: 'weekly-v1', kind: 'weekly', name: '当前周报模板', version: 1, active: 1, content: '{"sections":[{"title":"本周进展","guidance":"只用已确认记录","required":true}]}', created_at: '2026-09-05T00:00:00Z' },
  ];
  function admin() { const page=setup();page.run("WS_CONTEXT={canAdmin:true,users:[]};WS_VIEW='team'");return page; }

  it('全部资料同时展示参考资料和模板，分类与新增类型不重复出现在列表下方', async () => {
    const page=admin(),load=page.run<Promise<void>>("wsKnowledge('all')");
    expect(page.requests.map((request)=>request.url)).toEqual(['/api/v1/admin/knowledge','/api/v1/admin/templates']);
    page.requests[0].respond(200,{entries:[{id:'park',kind:'park_material',title:'园区说明',summary:'虚构资料',version:1,active:1}]});
    page.requests[1].respond(200,{templates});await load;
    const app=page.element('app'),text=textOf(app),nodes=descendants(app);
    for(const title of ['园区说明','当前日报模板','历史日报模板','当前周报模板']) expect(text).toContain(title);
    expect(nodes.filter((node)=>node.tag==='table')).toHaveLength(1);
    expect(nodes.filter((node)=>node.tag==='select'||node.tag==='form')).toHaveLength(0);
    expect(text).toContain('新增资料');
  });

  it('模板分类也先展示版本列表，而不是切tab就展开编辑表单', async () => {
    const page=admin(),load=page.run<Promise<void>>("wsKnowledge('daily_template')");
    page.requests[0].respond(200,{templates});await load;
    const app=page.element('app');
    expect(textOf(app)).toContain('当前日报模板');expect(textOf(app)).toContain('历史日报模板');
    expect(textOf(app)).not.toContain('当前周报模板');expect(textOf(app)).not.toContain('保存为新版本');
    expect(descendants(app).filter((node)=>node.tag==='select'||node.tag==='form')).toHaveLength(0);
  });

  it('空分类保留完整表头和跨列空状态，不再变成只有一句提示', async () => {
    const page=admin(),load=page.run<Promise<void>>("wsKnowledge('park_material')");
    page.requests[0].respond(200,{entries:[]});await load;
    const nodes=descendants(page.element('app'));
    expect(nodes.filter((node)=>node.tag==='th').map((node)=>node.textContent)).toEqual(['资料名称','类别','摘要','版本','状态','来源']);
    expect(nodes.find((node)=>node.tag==='td')).toMatchObject({colSpan:6});
    expect(nodes.filter((node)=>node.tag==='select')).toHaveLength(0);
  });

  it('资料类型仅在新增页出现，并预选当前分类', async () => {
    const page=admin();page.location.hash='#/knowledge/park_material/new';
    const load=page.run<Promise<void>>("wsKnowledge()");page.requests[0].respond(200,{entries:[]});await load;
    const typeField=descendants(page.element('app')).find((node)=>node.tag==='label'&&node.textContent==='资料类型');
    expect(typeField?.children[0]).toMatchObject({tag:'select',value:'park_material'});
    expect(descendants(page.element('app')).filter((node)=>node.tag==='table')).toHaveLength(0);
  });

  it('员工全部资料不请求管理员模板接口，也没有新增管理操作', async () => {
    const page=setup();page.run("WS_CONTEXT={canAdmin:false,users:[]};WS_VIEW='personal'");
    const load=page.run<Promise<void>>("wsKnowledge('all')");
    expect(page.requests.map((request)=>request.url)).toEqual(['/api/v1/workspace/knowledge?view=personal']);
    page.requests[0].respond(200,{entries:[]});await load;
    expect(textOf(page.element('app'))).not.toContain('新增资料');
    expect(descendants(page.element('app')).filter((node)=>node.tag==='table')).toHaveLength(1);
  });

  it('历史模板详情按选择版本只读展示，不拿当前模板覆盖历史内容', async () => {
    const page=admin();page.location.hash='#/knowledge/daily_template/daily-v1';
    const load=page.run<Promise<void>>('wsKnowledge()');page.requests[0].respond(200,{templates});await load;
    const text=textOf(page.element('app'));
    expect(text).toContain('历史日报模板');expect(text).not.toContain('当日进展');
    expect(text).not.toContain('编辑模板');expect(text).not.toContain('保存为新版本');
  });
});
