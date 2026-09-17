import { describe, expect, it } from 'vitest';
import { HttpAgent } from './http';
import type { AgentTaskRequest } from './contracts';

const request: AgentTaskRequest = {
  schemaVersion: 1,
  requestId: 'r1',
  idempotencyKey: 'k1',
  tenantId: 'poc',
  taskType: 'weekly_report_generate',
  actor: { role: 'manager', userRef: 'u1' },
  context: { timezone: 'Asia/Shanghai', sourceRecords: [{ id: 'd1', text: '完成走访', date: '2026-09-04' }] },
  input: {},
};

describe('HTTP Agent客户端', () => {
  it('校验远程结果与引用范围', async () => {
    const fake = (async () => new Response(JSON.stringify({
      taskType: 'weekly_report_generate',
      result: { schemaVersion: 1, summary: '本周完成走访', sections: [], citedReportIds: ['d1'] },
    }), { status: 200 })) as typeof fetch;
    const agent = new HttpAgent({ baseUrl: 'http://agent', apiKey: 'key' }, fake);
    expect((await agent.run(request)).taskType).toBe('weekly_report_generate');
  });
});
