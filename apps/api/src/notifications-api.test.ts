import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import * as repo from '@wecom/persistence';
import { startServer } from './server';

describe('主动消息管理HTTP接口', () => {
  it('管理员配置/查看/重试，员工和组长均不能操作系统通知配置', async () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'assistant-notifications-'));
    const dbPath = path.join(folder, 'poc.sqlite');
    const server = await startServer({ host: '127.0.0.1', port: 0, dbPath, accessCode: 'notification-test-only' });
    const db = repo.openDb(dbPath);
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const login = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessCode: 'notification-test-only' }) });
      const { token } = await login.json() as { token: string };
      const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
      const api = `${base}/api/v1/admin/notifications`;
      expect((await fetch(api)).status).toBe(401);
      const read = await fetch(api, { headers });
      expect(read.status).toBe(200);
      expect(await read.json()).toMatchObject({ settings: { crmAssignmentEnabled: false, crmDueEnabled: false, weeklyWeekday: 1, weeklyGenerateAt: '09:00', weeklyTarget: 'previous', riskEnabled: false }, queue: [] });
      const change = await fetch(`${api}/settings`, { method: 'PUT', headers, body: JSON.stringify({ crmDueEnabled: true, weeklyWeekday: 5, weeklyTarget: 'current', dailyReminderAt: '17:45', dailyReminderDays: [1, 3, 5], catchupDays: 3, riskEnabled: true, riskThreshold: 40, riskEarliestWeekday: 4 }) });
      expect(change.status).toBe(200);
      expect(await change.json()).toMatchObject({ settings: { crmDueEnabled: true, weeklyWeekday: 5, weeklyTarget: 'current', dailyReminderAt: '17:45', dailyReminderDays: [1, 3, 5], catchupDays: 3, riskEnabled: true, riskThreshold: 40, riskEarliestWeekday: 4 } });
      expect(await (await fetch(api, { headers })).json()).toMatchObject({ settings: { weeklyTarget: 'current', dailyReminderDays: [1, 3, 5], riskEnabled: true, riskThreshold: 40 } });
      expect((await fetch(`${api}/settings`, { method: 'PUT', headers, body: JSON.stringify({ dailyReminderAt: '27:99' }) })).status).toBe(400);
      for (const body of [{ weeklyTarget: 'next' }, { dailyReminderDays: [1, 1] }, { catchupDays: 7 }, { riskThreshold: 101 }]) {
        expect((await fetch(`${api}/settings`, { method: 'PUT', headers, body: JSON.stringify(body) })).status).toBe(400);
      }
      for (const role of ['employee', 'team_lead'] as const) {
        repo.upsertUser(db, { id: role, name: role, role, wecom_userid: `wx-${role}` });
        repo.insertAuthSession(db, { token_hash: createHash('sha256').update(role).digest('hex'), user_id: role, role, resource_id: null, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString() });
        const personHeaders = { authorization: `Bearer ${role}`, 'content-type': 'application/json' };
        expect((await fetch(api, { headers: personHeaders })).status).toBe(403);
        expect((await fetch(`${api}/settings`, { method: 'PUT', headers: personHeaders, body: '{}' })).status).toBe(403);
        expect((await fetch(`${api}/failed-1/retry`, { method: 'POST', headers: personHeaders })).status).toBe(403);
      }
      repo.insertOutbox(db, { id: 'failed-1', kind: 'daily_reminder', dedupe_key: 'failed-1', target_user_id: 'employee', status: 'failed', attempts: 1,
        last_error: 'https://internal.invalid/authorization-secret', payload_json: '{"secret":"not-for-ui"}', next_attempt_at: new Date().toISOString(), created_at: new Date().toISOString() });
      const queue = await (await fetch(api, { headers })).json();
      expect(JSON.stringify(queue)).not.toContain('authorization-secret');
      expect(JSON.stringify(queue)).not.toContain('not-for-ui');
      expect((await fetch(`${api}/failed-1/retry`, { method: 'POST', headers })).status).toBe(200);
      expect((await fetch(`${api}/failed-1/retry`, { method: 'POST', headers })).status).toBe(400);
      expect((db.prepare("SELECT status,attempts FROM message_outbox WHERE id='failed-1'").get())).toMatchObject({ status: 'pending', attempts: 0 });
      expect((db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'notifications.%'").get() as { n: number }).n).toBe(2);
    } finally {
      db.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      const target = path.resolve(folder);
      if (path.dirname(target) !== path.resolve(tmpdir()) || !path.basename(target).startsWith('assistant-notifications-')) throw new Error('测试临时目录范围校验失败');
      rmSync(target, { recursive: true, force: true });
    }
  });
});
