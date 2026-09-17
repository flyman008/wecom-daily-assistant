import { describe, it, expect, vi } from 'vitest';
import { ArkAgent, extractJson, loadArkConfigFromEnv, validateAgentResult } from './ark';
import type { AgentTaskRequest } from './contracts';

describe('extractJson', () => {
  it('提取裸 JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });
  it('提取 markdown 围栏内 JSON', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it('前后有文字也能提取', () => {
    expect(extractJson('好的：{"a":1} 以上')).toEqual({ a: 1 });
  });
});

function req(taskType: AgentTaskRequest['taskType']): AgentTaskRequest {
  return {
    schemaVersion: 1,
    requestId: 'r1',
    idempotencyKey: 'k1',
    tenantId: 'poc',
    taskType,
    actor: { role: 'employee', userRef: 'e001' },
    context: { timezone: 'Asia/Shanghai', workItems: [{ id: 'wi-1', name: '走访企业', planBackground: '' }] },
    input: { text: '走访1家，完成20%' },
  };
}

describe('ArkAgent（fake fetch，无网络）', () => {
  it('未知进度允许null并保留有限的完成键和累计数，不强迫模型填0', () => {
    const request = req('daily_record_extract');
    const base = { workItemRef: 'wi-1', progressText: '事实', progressValue: null, progressType: '其他', issues: [], nextActions: [], sourceRecordRefs: [] };
    const output = validateAgentResult(request, { schemaVersion: 1, summary: '事实', items: [{ ...base, completedKeys: ['企业A', '企业A'], retractedKeys: ['企业B'] }], missingFields: [], riskFlags: [] });
    if (output.taskType !== 'daily_record_extract') throw new Error('错误任务类型');
    expect(output.result.items[0]).toMatchObject({ progressValue: null, completedKeys: ['企业A'], retractedKeys: ['企业B'] });
    const zero = validateAgentResult(request, { schemaVersion: 1, summary: '事实', items: [{ ...base, completedCount: 0 }], missingFields: [], riskFlags: [] });
    if (zero.taskType !== 'daily_record_extract') throw new Error('错误任务类型');
    expect(zero.result.items[0].completedCount).toBe(0);
  });

  it('重复事项与后台未配置的类型不能通过输出契约', () => {
    const request = req('daily_record_extract');
    request.context.progressTypes = ['走访', '活动'];
    const item = { workItemRef: 'wi-1', progressText: '事实', progressValue: null, progressType: '走访', issues: [], nextActions: [], sourceRecordRefs: [] };
    const result = { schemaVersion: 1, summary: '事实', items: [item], missingFields: [], riskFlags: [] };
    expect(() => validateAgentResult(request, result)).not.toThrow();
    expect(() => validateAgentResult(request, { ...result, items: [item, item] })).toThrow('重复事项');
    expect(() => validateAgentResult(request, { ...result, items: [{ ...item, progressType: '模型自创类型' }] })).toThrow('已配置类型');
  });

  it('拒绝缺失/字符串进度、非整数累计数与隐藏控制字符键', () => {
    const request = req('daily_record_extract');
    const base = { workItemRef: 'wi-1', progressText: '事实', progressValue: null, progressType: '其他', issues: [], nextActions: [], sourceRecordRefs: [] };
    for (const extra of [{ progressValue: undefined }, { progressValue: '0' }, { completedCount: 1.2 }, { completedCount: -1 }, { completedKeys: ['隐藏\u202e字符'] }, { retractedKeys: [''] }]) {
      expect(() => validateAgentResult(request, { schemaVersion: 1, summary: '事实', items: [{ ...base, ...extra }], missingFields: [], riskFlags: [] })).toThrow();
    }
  });

  it('读取显式超时和输出上限配置', () => {
    expect(loadArkConfigFromEnv({
      NODE_ENV: 'test', ARK_BASE_URL: 'http://ark.local', ARK_API_KEY: 'test-only',
      ARK_MODEL: 'model-a', ARK_TIMEOUT_MS: '30000', ARK_MAX_TOKENS: '4096',
    })).toMatchObject({ model: 'model-a', timeoutMs: 30_000, maxTokens: 4_096 });
    expect(loadArkConfigFromEnv({
      NODE_ENV: 'test', ARK_BASE_URL: 'http://ark.local', ARK_API_KEY: 'test-only',
    }).timeoutMs).toBe(180_000);
  });

  it('解析 daily_record_extract 返回', async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({ content: [{ type: 'text', text: '{"schemaVersion":1,"summary":"走访A","items":[],"missingFields":[],"riskFlags":[]}' }] }),
        { status: 200 },
      )) as typeof fetch;
    const agent = new ArkAgent({ model: 'm', baseUrl: 'http://x', token: 't' }, fakeFetch);
    const r = await agent.run(req('daily_record_extract'));
    expect(r).toEqual({
      taskType: 'daily_record_extract',
      result: { schemaVersion: 1, summary: '走访A', items: [], missingFields: [], riskFlags: [] },
    });
  });

  it('拒绝引用上下文外事项的模型结果', async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          content: [{
            type: 'text',
            text: '{"schemaVersion":1,"summary":"异常","items":[{"workItemRef":"other","progressText":"x","progressValue":20,"progressType":"其他","issues":[],"nextActions":[],"sourceRecordRefs":[]}],"missingFields":[],"riskFlags":[]}',
          }],
        }),
        { status: 200 },
      )) as typeof fetch;
    const agent = new ArkAgent({ model: 'm', baseUrl: 'http://x', token: 't' }, fakeFetch);
    await expect(agent.run(req('daily_record_extract'))).rejects.toThrow('自动重试后仍未成功');
  });

  it('非法JSON自动重试，截断提高输出上限，重试不改变原始输入', async () => {
    const bodies: any[] = [];
    const good = {schemaVersion:1,summary:'走访A',items:[],missingFields:[],riskFlags:[]};
    const fakeFetch = vi.fn(async (_url: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      const content = bodies.length === 1 ? '{"items":[1 2]}' : JSON.stringify(good);
      return new Response(JSON.stringify({stop_reason:bodies.length===2?'max_tokens':'end_turn',content:[{type:'text',text:content}]}));
    });
    const agent = new ArkAgent({model:'m',baseUrl:'http://x',token:'t'},fakeFetch as typeof fetch);
    expect((await agent.run(req('daily_record_extract'))).result).toEqual(good);
    expect(bodies.map(b=>b.max_tokens)).toEqual([2048,4096,8192]);
    expect(bodies[1].messages[0].content).toContain(bodies[0].messages[0].content);
  });

  it('连续格式错误最多三次，不把半截结果返回；鉴权失败不重复请求', async () => {
    const invalid = vi.fn(async () => new Response(JSON.stringify({content:[{type:'text',text:'{"a":[1 2]}'}]})));
    await expect(new ArkAgent({model:'m',baseUrl:'http://x',token:'t'},invalid).run(req('daily_record_extract'))).rejects.toThrow('自动重试');
    expect(invalid).toHaveBeenCalledTimes(3);
    const denied = vi.fn(async () => new Response('',{status:401}));
    await expect(new ArkAgent({model:'m',baseUrl:'http://x',token:'t'},denied).run(req('daily_record_extract'))).rejects.toThrow('HTTP 401');
    expect(denied).toHaveBeenCalledTimes(1);
  });

  it('取消后不再重试', async () => {
    const abort = new AbortController();
    const fakeFetch = vi.fn(async () => {abort.abort();return new Response(JSON.stringify({content:[{type:'text',text:'invalid'}]}));});
    await expect(new ArkAgent({model:'m',baseUrl:'http://x',token:'t'},fakeFetch).run(req('daily_record_extract'),{signal:abort.signal})).rejects.toThrow();
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });
});
