import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import * as repo from '@wecom/persistence';
import { startServer } from './server';
import { directoryUrl, type DirectoryData } from './directory-sheet';

const data: DirectoryData = {
  employees: [{ '员工编号': 'RY001', '姓名': '测试员工', '部门': '一组', '角色': '员工', '上级员工编号': '', '状态': '启用' }],
  companies: [{ '企业编号': 'QY001', '企业名称': '测试公司', '行业': '', '园区': '', '负责员工编号': 'RY001', '联系人': '', '联系电话': '', '企业概况': '', '状态': '服务中' }],
};
const sheet = 'https://doc.weixin.qq.com/sheet/test-only';

describe('最小POC名录同步入口', () => {
  it('仅管理员能配置与同步；同步期间不允许重入和换表；失败保留原数据', async () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'assistant-directory-api-'));
    const dbPath = path.join(folder, 'test.sqlite');
    let finish: ((value: DirectoryData) => void) | undefined;
    let notifyStarted: (() => void) | undefined;
    let fail = false;
    const started = new Promise<void>(resolve => { notifyStarted = resolve; });
    const server = await startServer({ host: '127.0.0.1', port: 0, dbPath, accessCode: 'directory-test-only', directoryReader: async url => {
      expect(url).toBe(sheet);
      if (fail) throw new Error('模拟表格读取失败');
      return new Promise<DirectoryData>(resolve => { finish = resolve; notifyStarted?.(); });
    } });
    const db = repo.openDb(dbPath);
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const endpoint = `${base}/api/v1/admin/directory`;
      expect((await fetch(endpoint)).status).toBe(401);
      const login = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessCode: 'directory-test-only' }) });
      const { token } = await login.json() as { token: string };
      const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
      for (const role of ['employee', 'team_lead'] as const) {
        repo.upsertUser(db, { id: role, name: role, role });
        repo.insertAuthSession(db, { token_hash: createHash('sha256').update(role).digest('hex'), user_id: role, role, resource_id: null, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString() });
        for (const method of ['GET', 'PUT', 'POST']) {
          expect((await fetch(method === 'POST' ? `${endpoint}/sync` : endpoint, { method, headers: { authorization: `Bearer ${role}`, 'content-type': 'application/json' }, ...(method === 'PUT' ? { body: JSON.stringify({ url: sheet }) } : {}) })).status).toBe(403);
        }
      }
      expect((await fetch(`${endpoint}/sync`, { method: 'POST', headers })).status).toBe(400);
      const save = (url: string) => fetch(endpoint, { method: 'PUT', headers, body: JSON.stringify({ url }) });
      expect((await save('https://doc.weixin.qq.com/smartsheet/test')).status).toBe(400);
      expect((await save(sheet)).status).toBe(200);
      const pending = fetch(`${endpoint}/sync`, { method: 'POST', headers });
      await started;
      expect((await fetch(`${endpoint}/sync`, { method: 'POST', headers })).status).toBe(409);
      expect((await save('')).status).toBe(409);
      finish!(data);
      expect((await pending).status).toBe(200);
      const status = await (await fetch(endpoint, { headers })).json() as any;
      expect(status).toMatchObject({ url: sheet, busy: false, lastSync: { employees: 1, companies: 1 } });
      expect(repo.getUser(db, 'directory:user:RY001')?.wecom_userid).toBe('pending:directory:user:RY001');
      expect(db.prepare('SELECT COUNT(*) AS n FROM crm_company').get()?.n).toBe(1);
      fail = true;
      expect((await fetch(`${endpoint}/sync`, { method: 'POST', headers })).status).toBe(400);
      expect(db.prepare('SELECT COUNT(*) AS n FROM crm_company').get()?.n).toBe(1);
      expect((await (await fetch(endpoint, { headers })).json() as any).lastSync).toEqual(status.lastSync);
      expect((await save('')).status).toBe(200);
      expect(repo.getConfig(db, 'directorySheetUrl', 'fallback')).toBe('');
      expect(repo.getConfig(db, 'directoryLastSync', 'fallback')).toBeNull();
    } finally {
      finish?.(data);
      db.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
      if (path.dirname(path.resolve(folder)) !== path.resolve(tmpdir()) || !path.basename(folder).startsWith('assistant-directory-api-')) throw new Error('测试目录范围校验失败');
      rmSync(folder, { recursive: true, force: true });
    }
  });
  it('只接受普通企微表格链接，拒绝其他服务地址和嵌入凭证', () => {
    expect(directoryUrl(sheet)).toBe(sheet);
    expect(directoryUrl('')).toBe('');
    for (const url of ['http://doc.weixin.qq.com/sheet/x', 'https://evil.example/sheet/x', 'https://user:pass@doc.weixin.qq.com/sheet/x', 'https://doc.weixin.qq.com:123/sheet/x', 'https://doc.weixin.qq.com/doc/x']) expect(() => directoryUrl(url)).toThrow();
  });
});
