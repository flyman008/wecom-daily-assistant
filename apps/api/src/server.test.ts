import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { openDb } from '@wecom/persistence';
import * as repo from '@wecom/persistence';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer } from './server';

const cleanup: string[] = [];
afterEach(() => {
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('HTTP安全边界', () => {
  it('免码仅开放标记过的本机模拟库，真实库和非本机绑定不能开启', async () => {
    const directory = mkdtempSync(path.join(tmpdir(),'weekly-open-demo-')); cleanup.push(directory);
    const dbPath = path.join(directory,'demo.sqlite');
    await expect(startServer({host:'127.0.0.1',port:0,dbPath,accessCode:'test',localWeeklyDemo:true})).rejects.toThrow('独立模拟数据库');
    const db = openDb(dbPath);repo.setConfig(db,'weekly-ui-demo',true);repo.upsertUser(db,{id:'poc-admin',name:'负责人',role:'admin'});db.close();
    await expect(startServer({host:'0.0.0.0',port:0,dbPath,accessCode:'test',localWeeklyDemo:true})).rejects.toThrow('本机监听');
    for (const enabled of [false,true]) {
      const server=await startServer({host:'127.0.0.1',port:0,dbPath,accessCode:'test',localWeeklyDemo:enabled,allowedOrigins:['http://allowed.local']});
      try {
        const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        expect((await fetch(base+'/api/v1/demo/weekly-session',{method:'POST',headers:{origin:'https://evil.local'}})).status).toBe(403);
        const response=await fetch(base+'/api/v1/demo/weekly-session',{method:'POST'});
        expect(response.status).toBe(enabled?200:404);
        if(enabled) {
          const {token}=await response.json() as {token:string};
          expect((await fetch(base+'/api/v1/session',{headers:{authorization:`Bearer ${token}`}})).status).toBe(200);
        }
      } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));}
    }
  });
  it('公开周报未配置仍显示登录，非管理角色拒绝，显式管理者仅获得周报权限', async () => {
    const directory = mkdtempSync(path.join(tmpdir(),'public-weekly-poc-')); cleanup.push(directory);
    const dbPath = path.join(directory,'poc.sqlite');
    const db = openDb(dbPath);
    repo.upsertUser(db,{id:'directory:manager',name:'示例负责人',role:'employee'});
    db.close();

    const closed = await startServer({host:'127.0.0.1',port:0,dbPath,accessCode:'test'});
    try {
      const base=`http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
      expect(await (await fetch(base+'/')).text()).toContain('运营管理后台');
      expect((await fetch(base+'/api/v1/demo/weekly-session',{method:'POST'})).status).toBe(404);
    } finally { await new Promise<void>(resolve=>closed.close(()=>resolve())); }

    await expect(startServer({host:'127.0.0.1',port:0,dbPath,accessCode:'test',publicWeeklyUserName:'示例负责人'}))
      .rejects.toThrow('仅允许管理角色');
    const promoted = openDb(dbPath);
    repo.upsertUser(promoted,{id:'directory:manager',name:'示例负责人',role:'dept_head'});
    promoted.close();
    const server = await startServer({host:'127.0.0.1',port:0,dbPath,accessCode:'test',publicWeeklyUserName:'示例负责人'});
    try {
      const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      expect(await (await fetch(base+'/')).text()).toContain('日报助手 · 工作周报');
      const login=await fetch(base+'/api/v1/demo/weekly-session',{method:'POST'});
      expect(login.status).toBe(200);
      const {token}=await login.json() as {token:string};
      const headers={authorization:`Bearer ${token}`};
      expect(await (await fetch(base+'/api/v1/session',{headers})).json()).toMatchObject({name:'示例负责人',role:'dept_head',publicWeekly:true,canAdmin:false,canManageTeam:true});
      expect((await fetch(base+'/api/v1/workspace?view=team',{headers})).status).toBe(200);
      expect((await fetch(base+'/api/v1/reporting/weeks?weekId=2026-09-07',{headers})).status).toBe(200);
      expect((await fetch(base+'/api/v1/admin/users',{headers})).status).toBe(403);
      expect((await fetch(base+'/api/v1/reporting/types',{headers})).status).toBe(403);
    } finally { await new Promise<void>(resolve=>server.close(()=>resolve())); }
  });
  it('公开员工周报仅签发给显式员工，并限定本人只读周报', async () => {
    const directory = mkdtempSync(path.join(tmpdir(),'public-employee-weekly-poc-')); cleanup.push(directory);
    const dbPath = path.join(directory,'poc.sqlite');
    const db = openDb(dbPath);
    repo.upsertUser(db,{id:'directory:manager',name:'示例负责人',role:'dept_head'});
    repo.upsertUser(db,{id:'directory:employee',name:'示例员工',role:'employee',manager_user_id:'directory:manager'});
    db.close();

    const closed = await startServer({host:'127.0.0.1',port:0,dbPath,accessCode:'test'});
    try {
      const base=`http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
      expect((await fetch(base+'/employee-weekly.html')).status).toBe(404);
      expect((await fetch(base+'/api/v1/demo/employee-weekly-session',{method:'POST'})).status).toBe(404);
    } finally { await new Promise<void>(resolve=>closed.close(()=>resolve())); }

    await expect(startServer({host:'127.0.0.1',port:0,dbPath,accessCode:'test',publicWeeklyEmployeeName:'示例负责人'}))
      .rejects.toThrow('仅允许员工角色');
    const server = await startServer({host:'127.0.0.1',port:0,dbPath,accessCode:'test',publicWeeklyEmployeeName:'示例员工'});
    try {
      const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      expect(await (await fetch(base+'/employee-weekly.html')).text()).toContain('日报助手 · 我的周报');
      const login=await fetch(base+'/api/v1/demo/employee-weekly-session',{method:'POST'});
      expect(login.status).toBe(200);
      const {token}=await login.json() as {token:string};
      const headers={authorization:`Bearer ${token}`};
      expect(await (await fetch(base+'/api/v1/session',{headers})).json()).toMatchObject({name:'示例员工',role:'employee',publicWeeklyEmployee:true,canAdmin:false,canManageTeam:false});
      expect((await fetch(base+'/api/v1/workspace?view=personal',{headers})).status).toBe(200);
      expect((await fetch(base+'/api/v1/workspace?view=team',{headers})).status).toBe(403);
      expect((await fetch(base+'/api/v1/reporting/weeks/directory%3Aemployee/2026-09-07',{headers})).status).toBe(200);
      expect((await fetch(base+'/api/v1/reporting/weeks/directory%3Amanager/2026-09-07',{headers})).status).toBe(403);
      expect((await fetch(base+'/api/v1/reporting/weeks?weekId=2026-09-07',{headers})).status).toBe(403);
      expect((await fetch(base+'/api/v1/reporting/feedback',{method:'POST',headers:{...headers,'content-type':'application/json'},body:'{}'})).status).toBe(403);
      expect((await fetch(base+'/api/v1/admin/users',{headers})).status).toBe(403);
    } finally { await new Promise<void>(resolve=>server.close(()=>resolve())); }
  });
  it('健康检查公开，业务接口需登录且只允许白名单Origin', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'assistant-api-'));
    cleanup.push(directory);
    const origin = 'https://poc.example.test';
    const server = await startServer({
      host: '127.0.0.1',
      port: 0,
      dbPath: path.join(directory, 'poc.sqlite'),
      accessCode: 'test-code',
      allowedOrigins: [origin],
      demoMode: true,
    });
    try {
      const address = server.address() as AddressInfo;
      const base = `http://127.0.0.1:${address.port}`;
      expect((await fetch(`${base}/api/v1/health`)).status).toBe(200);
      expect((await fetch(`${base}/api/v1/dashboard`)).status).toBe(401);
      expect((await fetch(`${base}/api/v1/auth/login`, {
        method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
        body: JSON.stringify({ accessCode: 'test-code' }),
      })).status).toBe(403);

      const login = await fetch(`${base}/api/v1/auth/login`, {
        method: 'POST', headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ accessCode: 'test-code' }),
      });
      expect(login.status).toBe(200);
      expect(login.headers.get('access-control-allow-origin')).toBe(origin);
      const { token } = await login.json() as { token: string };
      const dashboard = await fetch(`${base}/api/v1/dashboard`, {
        headers: { origin, authorization: `Bearer ${token}` },
      });
      expect(dashboard.status).toBe(200);
      expect(((await dashboard.json()) as { employees: unknown[] }).employees.length).toBeGreaterThan(0);

      const settings = await fetch(`${base}/api/v1/admin/settings`, {
        method: 'POST',
        headers: { origin, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ weekBoundary: 'work_week', maxWorkItems: 8 }),
      });
      expect(settings.status).toBe(200);
      expect(await settings.json()).toMatchObject({ weekBoundary: 'work_week', maxWorkItems: 8 });

      const fullSettings = await fetch(`${base}/api/v1/admin/settings`, {
        method: 'POST', headers: { origin, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          weekBoundary: 'natural_week', maxWorkItems: 10, confirmPolicy: 'button_only', progressMode: 'cumulative',
          dailyReminderAt: '17:45', weeklyGenerateAt: '18:15', sourceRetentionDays: 365, attachmentRetentionDays: 90,
        }),
      });
      expect(fullSettings.status).toBe(200);
      expect(await fullSettings.json()).toMatchObject({ confirmPolicy: 'button_only', dailyReminderAt: '17:45' });

      const template = await fetch(`${base}/api/v1/admin/templates`, {
        method: 'POST',
        headers: { origin, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'weekly', name: '测试周报模板', content: '{"sections":["进展"]}' }),
      });
      expect(template.status).toBe(201);
      expect(((await template.json()) as { template: { version: number } }).template.version).toBe(2);

      const knowledge = await fetch(`${base}/api/v1/admin/knowledge`, {
        method: 'POST', headers: { origin, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'service_company', title: '示例企业', summary: '重点服务企业', content: '跟进落地诉求', tags: ['重点'], sourceName: '企业台账',
        }),
      });
      expect(knowledge.status).toBe(201);
      const knowledgeBody = await knowledge.json() as { entry: { id: string; version: number } };
      expect(knowledgeBody.entry.version).toBe(1);
      const knowledgeList = await fetch(`${base}/api/v1/admin/knowledge?kind=service_company`, {
        headers: { origin, authorization: `Bearer ${token}` },
      });
      expect(((await knowledgeList.json()) as { entries: unknown[] }).entries).toHaveLength(1);

      const archive = await fetch(`${base}/api/v1/admin/exports`, {
        method: 'POST',
        headers: { origin, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ year: 2026, quarter: 3, userId: 'e001' }),
      });
      expect(archive.status).toBe(200);
      expect(((await archive.json()) as { dailyReports: unknown[] }).dailyReports.length).toBeGreaterThan(0);

      const db = openDb(path.join(directory, 'poc.sqlite'));
      repo.upsertUser(db, { id: 'm001', name: '主管', role: 'team_lead' });
      repo.upsertUser(db, { id: 'e001', name: '张三', role: 'employee', manager_user_id: 'm001' });
      const weekly = repo.getWeeklyReport(db, 'e001', '2026-08-31');
      expect(weekly).toBeTruthy();
      const grantToken = 'single-use-report-token';
      repo.insertAccessGrant(db, {
        id: 'grant-1', token_hash: createHash('sha256').update(grantToken).digest('hex'),
        user_id: 'm001', resource_type: 'weekly_report', resource_id: weekly!.id,
        expires_at: new Date(Date.now() + 60_000).toISOString(), created_at: new Date().toISOString(),
      });
      db.close();

      const grantLogin = await fetch(`${base}/api/v1/access-grants/exchange`, {
        method: 'POST', headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ token: grantToken }),
      });
      expect(grantLogin.status).toBe(200);
      const grantSession = await grantLogin.json() as { token: string; route: string };
      expect(grantSession.route).toBe('#/report/e001/2026-08-31');
      expect((await fetch(`${base}/api/v1/reports/e001/2026-08-31`, {
        headers: { origin, authorization: `Bearer ${grantSession.token}` },
      })).status).toBe(200);
      expect((await fetch(`${base}/api/v1/dashboard`, {
        headers: { origin, authorization: `Bearer ${grantSession.token}` },
      })).status).toBe(403);
      expect((await fetch(`${base}/api/v1/access-grants/exchange`, {
        method: 'POST', headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ token: grantToken }),
      })).status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('API重启后短时会话仍有效，退出后立即失效', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'assistant-session-'));
    cleanup.push(directory);
    const dbPath = path.join(directory, 'poc.sqlite');
    const first = await startServer({ host: '127.0.0.1', port: 0, dbPath, accessCode: 'restart-code' });
    const firstBase = `http://127.0.0.1:${(first.address() as AddressInfo).port}`;
    const login = await fetch(`${firstBase}/api/v1/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessCode: 'restart-code' }),
    });
    const { token } = await login.json() as { token: string };
    await new Promise<void>((resolve) => first.close(() => resolve()));

    const second = await startServer({ host: '127.0.0.1', port: 0, dbPath, accessCode: 'restart-code' });
    try {
      const secondBase = `http://127.0.0.1:${(second.address() as AddressInfo).port}`;
      expect((await fetch(`${secondBase}/api/v1/session`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
      expect((await fetch(`${secondBase}/api/v1/auth/logout`, {
        method: 'POST', headers: { authorization: `Bearer ${token}` },
      })).status).toBe(200);
      expect((await fetch(`${secondBase}/api/v1/session`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => second.close(() => resolve()));
    }
  });

  it('后台维护人员档案、角色和汇报关系，并签发一次性绑定码', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'assistant-users-'));
    cleanup.push(directory);
    const dbPath = path.join(directory, 'poc.sqlite');
    const setupDb = openDb(dbPath);
    repo.upsertUser(setupDb, { id: 'manager-id', wecom_userid: 'wm-manager', name: '赵主管', role: 'team_lead' });
    repo.upsertUser(setupDb, { id: 'employee-id', wecom_userid: 'wm-employee', name: '钱员工', role: 'employee' });
    repo.upsertUser(setupDb, { id: 'pending-id', wecom_userid: 'wm-pending', name: 'wm-pending', role: 'employee' });
    setupDb.close();

    const server = await startServer({ host: '127.0.0.1', port: 0, dbPath, accessCode: 'users-code' });
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const login = await fetch(`${base}/api/v1/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessCode: 'users-code' }),
      });
      const { token } = await login.json() as { token: string };
      const headers = { authorization: `Bearer ${token}` };

      const usersResponse = await fetch(`${base}/api/v1/admin/users`, { headers });
      expect(usersResponse.status).toBe(200);
      const usersBody = await usersResponse.json() as {
        roles: Array<{ value: string; label: string }>;
        directory: { source: string; fullSync: boolean };
        users: Array<Record<string, unknown>>;
      };
      expect(usersBody.roles).toEqual([
        { value: 'employee', label: '员工' },
        { value: 'team_lead', label: '小组长' },
        { value: 'dept_head', label: '部门领导' },
        { value: 'admin', label: '管理员' },
      ]);
      expect(usersBody.directory).toMatchObject({ source: 'admin_roster_with_wecom_binding', fullSync: false });
      expect(usersBody.users.find((user) => user.id === 'employee-id')).toMatchObject({
        name: '钱员工', displayName: '钱员工', role: 'employee', managerUserId: null, bindingStatus: 'bound',
      });
      expect(usersBody.users.find((user) => user.id === 'pending-id')).toMatchObject({
        name: 'wm-pending', bindingStatus: 'bound',
      });
      expect(usersBody.users[0]).not.toHaveProperty('wecom_userid');

      const updated = await fetch(`${base}/api/v1/admin/users/employee-id`, {
        method: 'PUT',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: '钱同事', role: 'team_lead', managerUserId: 'manager-id' }),
      });
      expect(updated.status).toBe(200);
      expect(await updated.json()).toMatchObject({
        user: { displayName: '钱同事', role: 'team_lead', managerUserId: 'manager-id', managerName: '赵主管' },
      });

      const invalidManager = await fetch(`${base}/api/v1/admin/users/employee-id`, {
        method: 'PUT',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'team_lead', managerUserId: 'pending-id' }),
      });
      expect(invalidManager.status).toBe(400);
      expect(await invalidManager.json()).toMatchObject({ error: '员工角色不能被设为上级' });

      const cycle = await fetch(`${base}/api/v1/admin/users/manager-id`, {
        method: 'PUT',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'team_lead', managerUserId: 'employee-id' }),
      });
      expect(cycle.status).toBe(400);
      expect(await cycle.json()).toMatchObject({ error: '汇报关系不能形成循环' });

      const managerWithReports = await fetch(`${base}/api/v1/admin/users/manager-id`, {
        method: 'PUT',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'employee', managerUserId: '' }),
      });
      expect(managerWithReports.status).toBe(400);
      expect(await managerWithReports.json()).toMatchObject({ error: '该成员仍有直属人员，请先调整他们的汇报关系' });

      const missing = await fetch(`${base}/api/v1/admin/users/not-recognized`, {
        method: 'PUT',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'employee', managerUserId: '' }),
      });
      expect(missing.status).toBe(404);
      const create = await fetch(`${base}/api/v1/admin/users`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ name: '手工人员', department: '企业服务部', role: 'employee', managerUserId: 'manager-id' }),
      });
      expect(create.status).toBe(201);
      const created = await create.json() as { user: { id: string; bindingStatus: string }; activationCode: string };
      expect(created.user.bindingStatus).toBe('unbound');
      expect(created.activationCode).toMatch(/^SN-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

      const verifyDb = openDb(dbPath);
      expect(repo.getUser(verifyDb, 'employee-id')).toMatchObject({
        wecom_userid: 'wm-employee', name: '钱同事', role: 'team_lead', manager_user_id: 'manager-id',
      });
      expect(repo.getUser(verifyDb, created.user.id)).toMatchObject({
        name: '手工人员', department: '企业服务部', role: 'employee', manager_user_id: 'manager-id',
      });
      const storedCode = repo.getLatestActivationCode(verifyDb, created.user.id)!;
      expect(storedCode.code_hash).not.toContain(created.activationCode);
      verifyDb.close();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
