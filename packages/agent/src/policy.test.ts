import { describe, expect, it } from 'vitest';
import type { AgentTaskRequest } from './contracts';
import type { Agent } from './mock';
import { GuardedAgent, validateAgentRequest } from './policy';
import { MockAgent } from './mock';

function request(): AgentTaskRequest {
  return {
    schemaVersion: 1,
    requestId: 'r1',
    idempotencyKey: 'k1',
    tenantId: 'poc',
    taskType: 'daily_record_extract',
    actor: { role: 'employee', userRef: 'u1' },
    context: {
      timezone: 'Asia/Shanghai',
      workItems: [{ id: 'wi1', name: '走访企业', planBackground: '' }],
      sourceRecords: [{ id: 's1', text: '完成走访', date: '2026-09-05' }],
    },
    input: { text: '完成走访' },
  };
}

describe('Agent输入输出门禁', () => {
  it('畸形集合、null元素和缺少来源正文在调用模型前被明确拒绝', async () => {
    let calls = 0;
    const guarded = new GuardedAgent({ async run(value) { calls++; return new MockAgent().run(value); } });
    for (const context of [
      { workItems: {} }, { workItems: [null] }, { sourceRecords: 's1' },
      { sourceRecords: [null] }, { sourceRecords: [{ id: 's1', date: '2026-09-05' }] },
      { knowledgeSnippets: {} }, { knowledgeSnippets: [null] },
    ]) {
      const value = request(); Object.assign(value.context, context);
      await expect(guarded.run(value)).rejects.toThrow(/必须是/);
    }
    const value = request(); value.input.attachments = [null] as never;
    await expect(guarded.run(value)).rejects.toThrow('必须是对象');
    expect(calls).toBe(0);
  });

  it('进展类型是有限不重复的后台枚举，Mock不虚构枚举外类型', async () => {
    const value = request();
    for (const types of [[], [''], ['走访', '走访'], ['走访\u202e'], [' 走访 ']]) {
      value.context.progressTypes = types;
      expect(() => validateAgentRequest(value)).toThrow('progressTypes');
    }
    value.context.progressTypes = ['走访', '活动'];
    value.input.text = '已走访企业A';
    const named = await new GuardedAgent(new MockAgent()).run(value);
    if (named.taskType !== 'daily_record_extract') throw new Error('错误类型');
    expect(named.result.items[0].progressType).toBe('走访');
    value.input.text = '今天有新情况';
    const unknown = await new GuardedAgent(new MockAgent()).run(value);
    if (unknown.taskType !== 'daily_record_extract') throw new Error('错误类型');
    expect(unknown.result.items).toEqual([]);
    expect(unknown.result.missingFields.join('')).toContain('类型');
  });

  it('目标配置必须是可计算的明确总数，不允许无单位或非法取整规则', () => {
    const value = request();
    value.context.workItems![0].metric = { mode: 'count', total: 3, unit: '家', rounding: 'floor', version: 1 };
    expect(() => validateAgentRequest(value)).not.toThrow();
    value.context.workItems![0].metric.total = 0;
    expect(() => validateAgentRequest(value)).toThrow('总数');
    value.context.workItems![0].metric = { mode: 'percent', total: null, unit: '%', rounding: 'round', version: 1 };
    expect(() => validateAgentRequest(value)).not.toThrow();
  });

  it('Mock无明示数字返回null，多事项未匹配时不擅自绑定第一项', async () => {
    const value = request();
    const response = await new GuardedAgent(new MockAgent()).run(value);
    if (response.taskType !== 'daily_record_extract') throw new Error('错误任务类型');
    expect(response.result.items[0].progressValue).toBeNull();
    value.context.workItems!.push({ id: 'wi2', name: '梳理合同', planBackground: '' });
    value.input.text = '今天沟通了新情况';
    const ambiguous = await new GuardedAgent(new MockAgent()).run(value);
    if (ambiguous.taskType !== 'daily_record_extract') throw new Error('错误任务类型');
    expect(ambiguous.result.items).toEqual([]);
    expect(ambiguous.result.missingFields.join('')).toContain('明确');
  });

  it('拒绝未定义任务类型', () => {
    const value = request();
    (value as { taskType: string }).taskType = 'free_chat';
    expect(() => validateAgentRequest(value)).toThrow('taskType无效');
  });

  it('拒绝重复的上下文ID', () => {
    const value = request();
    value.context.sourceRecords?.push({ id: 's1', text: '重复', date: '2026-09-05' });
    expect(() => validateAgentRequest(value)).toThrow('重复ID');
  });

  it('拒绝超长输入，避免无限制扩张上下文', () => {
    const value = request();
    value.input.text = 'a'.repeat(100_001);
    expect(() => validateAgentRequest(value)).toThrow('input.text超过长度限制');
  });

  it('统一拒绝模型引用上下文之外的事项', async () => {
    const delegate: Agent = {
      async run() {
        return {
          taskType: 'daily_record_extract',
          result: {
            schemaVersion: 1,
            summary: '异常',
            items: [{
              workItemRef: 'unknown', progressText: 'x', progressValue: 1,
              progressType: '其他', issues: [], nextActions: [], sourceRecordRefs: ['s1'],
            }],
            missingFields: [], riskFlags: [],
          },
        };
      },
    };
    await expect(new GuardedAgent(delegate).run(request())).rejects.toThrow('workItemRef不在本周事项中');
  });
});
