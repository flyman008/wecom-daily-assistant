import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { insertAuthSession, openDb, upsertUser } from '@wecom/persistence';
import type { Role } from '@wecom/domain';
import { CrmStore, type CrmEntity, type CrmStage } from '../../../packages/persistence/src/crm';
import { startServer } from './server';

const fixtures: Array<{ server: Awaited<ReturnType<typeof startServer>>; directory: string }> = [];

async function setup(demoMode = false) {
  const directory = mkdtempSync(join(tmpdir(), 'crm-api-test-'));
  const dbPath = join(directory, 'poc.sqlite');
  const server = await startServer({ host: '127.0.0.1', port: 0, dbPath, accessCode: 'isolated-crm-test', demoMode });
  fixtures.push({ server, directory });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessCode: 'isolated-crm-test' }) });
  expect(login.status).toBe(200);
  const { token: adminToken } = await login.json() as { token: string };
  const request = (suffix = '', method = 'GET', body?: unknown, token: string | null = adminToken) => fetch(`${base}/api/v1/admin/crm${suffix}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const session = (role: Role, resourceId: string | null = null) => {
    const token = `isolated-${role}-${resourceId ?? 'full'}`;
    const db = openDb(dbPath);
    try {
      upsertUser(db, { id: `test-${role}`, name: `测试${role}`, role });
      insertAuthSession(db, { token_hash: createHash('sha256').update(token).digest('hex'),
        user_id: `test-${role}`, role, resource_id: resourceId,
        created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString() });
    } finally { db.close(); }
    return token;
  };
  return { request, session, dbPath, base, adminToken };
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

describe('CRM HTTP 权限与环境边界', () => {
  it('未登录401，员工/小组长/部门领导及报告限定管理员都不能读写CRM', async () => {
    const { request, session } = await setup();
    expect((await request('', 'GET', undefined, null)).status).toBe(401);
    expect((await request('/companies', 'POST', { name: '未授权创建' }, null)).status).toBe(401);
    expect((await request('', 'GET', undefined, 'invalid-token')).status).toBe(401);
    for (const role of ['employee', 'team_lead', 'dept_head'] as const) {
      const token = session(role);
      expect((await request('', 'GET', undefined, token)).status).toBe(403);
      expect((await request('/options', 'GET', undefined, token)).status).toBe(403);
      expect((await request('/companies', 'POST', { name: '越权创建' }, token)).status).toBe(403);
      expect((await request('/stages', 'PUT', { stages: [] }, token)).status).toBe(403);
    }
    const scopedAdmin = session('admin', 'one-report-only');
    expect((await request('', 'GET', undefined, scopedAdmin)).status).toBe(403);
    expect((await request('/companies', 'POST', { name: '限定会话越权创建' }, scopedAdmin)).status).toBe(403);
    const visible = await request();
    expect(visible.status).toBe(200);
    expect((await visible.json() as { companies: unknown[] }).companies).toHaveLength(0);
  });

  it('只有demoMode启用演示企业，常规启动没有自动注入业务数据', async () => {
    const normal = await setup();
    const real = await normal.request();
    expect((await real.json() as { companies: CrmEntity[] }).companies).toHaveLength(0);
    const demo = await setup(true);
    const demoBody = await (await demo.request()).json() as { companies: CrmEntity[]; records: unknown[] };
    expect(demoBody.companies).toHaveLength(3);
    expect(demoBody.companies.every((company) => company.isDemo)).toBe(true);
    expect(demoBody.records.length).toBeGreaterThan(0);
  });

  it('租户及审计身份由服务端确定，JSON中的tenantId/actor/isDemo不能覆盖', async () => {
    const { request, dbPath } = await setup();
    const response = await request('/companies', 'POST', { name: '范围测试', tenantId: 'other', actor: 'forged-admin', isDemo: true, id: 'chosen-id', version: 99 });
    expect(response.status).toBe(201);
    const { company } = await response.json() as { company: CrmEntity };
    expect(company).toMatchObject({ isDemo: false, version: 1 });
    expect(company.id).not.toBe('chosen-id');
    const detail = await (await request(`/companies/${company.id}`)).json() as { events: Array<{ actor_id: string; tenant_id: string }> };
    expect(detail.events[0]).toMatchObject({ actor_id: 'poc-admin', tenant_id: 'poc' });
    const db = openDb(dbPath);
    try {
      db.prepare('INSERT INTO tenant(id,name,created_at) VALUES(?,?,?)').run('other', '测试隔离租户', new Date().toISOString());
      const other = new CrmStore(db, 'other').saveCompany({ name: '其他租户企业' }, 'other-admin');
      expect((await request(`/companies/${other.id}`)).status).toBe(404);
      expect((await request(`/companies/${other.id}`, 'PUT', { version: 1, summary: '跨租户改写', reason: '冒用' })).status).toBe(404);
    } finally { db.close(); }
  });
});

describe('CRM HTTP 业务校验与失败响应', () => {
  it('新增/详情/更新/归档可用，重复企业与陈旧版本409，删除不做物理清理', async () => {
    const { request } = await setup();
    const created = await request('/companies', 'POST', { name: 'ＡＢＣ 企业', summary: '原始信息' });
    expect(created.status).toBe(201);
    const { company } = await created.json() as { company: CrmEntity };
    expect((await request('/companies', 'POST', { name: 'abc企业' })).status).toBe(409);
    expect((await request(`/companies/${company.id}`)).status).toBe(200);
    expect((await request(`/companies/${company.id}`, 'PUT', { version: 1, summary: '更新信息', reason: '核实' })).status).toBe(200);
    expect((await request(`/companies/${company.id}`, 'PUT', { version: 1, summary: '陈旧信息', reason: '过期页面' })).status).toBe(409);
    expect((await request(`/companies/${company.id}`, 'DELETE')).status).toBe(405);
    const archived = await request(`/companies/${company.id}`, 'PUT', { version: 2, archived: true, reason: '归档' });
    expect(archived.status).toBe(200);
    expect((await archived.json() as { company: CrmEntity }).company).toMatchObject({ archived: true, summary: '更新信息', version: 3 });
    expect((await request(`/companies/${company.id}/followups`, 'POST', { content: '归档后不能追加' })).status).toBe(400);
    expect((await request(`/companies/${company.id}`, 'PUT', { version: 3, archived: false, reason: '恢复' })).status).toBe(200);
  });

  it('项目和服务返回正确状态码，非法阶段及空结案结果不保存', async () => {
    const { request } = await setup();
    const { company } = await (await request('/companies', 'POST', { name: '事项测试' })).json() as { company: CrmEntity };
    expect((await request(`/companies/${company.id}/projects`, 'POST', { title: '非法阶段', stageId: 'invalid' })).status).toBe(400);
    const projectResponse = await request(`/companies/${company.id}/projects`, 'POST', { title: '真实项目', stageId: 'needs' });
    expect(projectResponse.status).toBe(201);
    const { record: project } = await projectResponse.json() as { record: CrmEntity };
    expect((await request(`/companies/${company.id}/projects/${project.id}`, 'PUT', { version: 1, stageId: 'visit', reason: '已预约考察' })).status).toBe(200);
    expect((await request(`/companies/${company.id}/projects/${project.id}`, 'PUT', { version: 1, stageId: 'landed', reason: '陈旧阶段' })).status).toBe(409);
    expect((await request(`/companies/${company.id}/services`, 'POST', { title: '无结果结案', status: 'resolved', outcome: '' })).status).toBe(400);
    const resolved = await request(`/companies/${company.id}/services`, 'POST', { title: '材料服务', status: 'resolved', outcome: '材料已送达并核实' });
    expect(resolved.status).toBe(201);
    const detail = await (await request(`/companies/${company.id}`)).json() as { records: CrmEntity[] };
    expect(detail.records).toHaveLength(2);
  });

  it('未来发生日期和非法JSON400，未知路径404，编码注入ID不会变成查询条件', async () => {
    const { request, base, adminToken } = await setup();
    expect((await request('/companies', 'POST', { name: '未来企业', occurredOn: '2999-01-01' })).status).toBe(400);
    const { company } = await (await request('/companies', 'POST', { name: '日期测试', nextDate: '2999-01-01' })).json() as { company: CrmEntity };
    expect((await request(`/companies/${company.id}/followups`, 'POST', { content: '未来事实', occurredOn: '2999-01-01' })).status).toBe(400);
    expect((await request('/not-a-route')).status).toBe(404);
    expect((await request(`/companies/${encodeURIComponent("' OR 1=1 --")}`)).status).toBe(404);
    expect((await request('/companies/%')).status).toBe(400);
    const malformed = await fetch(`${base}/api/v1/admin/crm/companies`, { method: 'POST', headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' }, body: '{invalid' });
    expect(malformed.status).toBe(400);
    const nonObject = await request('/companies', 'POST', ['not-object']);
    expect(nonObject.status).toBe(400);
    expect((await (await request()).json() as { companies: unknown[] }).companies).toHaveLength(1);
  });

  it('阶段配置需要最新快照，重复提交旧快照409且稳定ID不能删除', async () => {
    const { request } = await setup();
    const { stages } = await (await request('/options')).json() as { stages: CrmStage[] };
    const updated = stages.map((stage) => stage.id === 'lead' ? { ...stage, label: '首次联络' } : stage);
    const saved = await request('/stages', 'PUT', { previousStages: stages, stages: updated });
    expect(saved.status).toBe(200);
    const { stages: latest } = await saved.json() as { stages: CrmStage[] };
    expect((await request('/stages', 'PUT', { previousStages: stages, stages: updated })).status).toBe(409);
    expect((await request('/stages', 'PUT', { previousStages: latest, stages: latest.filter((stage) => stage.id !== 'lead') })).status).toBe(400);
    const reread = await (await request('/options')).json() as { stages: CrmStage[] };
    expect(reread.stages).toEqual(latest);
  });
});
