import { describe, expect, it } from 'vitest';
import type { AgentTaskRequest } from './contracts';
import { loadOpenAICompatibleConfigFromEnv, OpenAICompatibleAgent } from './openai-compatible';

const request: AgentTaskRequest = {
  schemaVersion: 1,
  requestId: 'r1',
  idempotencyKey: 'k1',
  tenantId: 'poc',
  taskType: 'daily_record_extract',
  actor: { role: 'employee', userRef: 'u1' },
  context: {
    timezone: 'Asia/Shanghai',
    workItems: [{ id: 'wi1', name: '走访企业', planBackground: '' }],
    sourceRecords: [{ id: 's1', text: '走访一家企业', date: '2026-09-05' }],
  },
  input: { text: '走访一家企业' },
};

describe('OpenAI-compatible Agent（fake fetch，无网络）', () => {
  it('DeepSeek格式异常自动重试，认证失败不重试',async()=>{
    let calls=0;
    const fake=(async(_url:any,init:any)=>{calls++;const sent=JSON.parse(init.body);expect(sent.thinking).toEqual({type:'disabled'});expect(sent.response_format.type).toBe('json_object');return new Response(JSON.stringify({choices:[{message:{content:calls===1?'broken':'{"schemaVersion":1,"summary":"完成走访","items":[],"missingFields":[],"riskFlags":[]}'}}]}));}) as typeof fetch;
    await new OpenAICompatibleAgent({baseUrl:'https://api.deepseek.com',token:'test',model:'deepseek-v4-flash'},fake).run(request);expect(calls).toBe(2);
    calls=0;const denied=(async()=>{calls++;return new Response('',{status:401});}) as typeof fetch;
    await expect(new OpenAICompatibleAgent({baseUrl:'https://api.deepseek.com',token:'test',model:'deepseek-v4-flash'},denied).run(request)).rejects.toThrow('401');expect(calls).toBe(1);
  });
  it('读取显式配置并调用chat completions', async () => {
    let url = '';
    let sent: Record<string, unknown> = {};
    const fake = (async (input: string | URL | Request, init?: RequestInit) => {
      url = String(input);
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"schemaVersion":1,"summary":"完成走访","items":[],"missingFields":[],"riskFlags":[]}' } }],
      }), { status: 200 });
    }) as typeof fetch;
    const config = loadOpenAICompatibleConfigFromEnv({
      NODE_ENV: 'test',
      OPENAI_COMPATIBLE_BASE_URL: 'http://model.local/v1/',
      OPENAI_COMPATIBLE_API_KEY: 'test-only',
      OPENAI_COMPATIBLE_MODEL: 'model-a',
    });
    const result = await new OpenAICompatibleAgent(config, fake).run(request);
    expect(result.taskType).toBe('daily_record_extract');
    expect(url).toBe('http://model.local/v1/chat/completions');
    expect(sent.model).toBe('model-a');
    expect(sent.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'system' })]));
  });

  it('生产配置拒绝明文HTTP', () => {
    expect(() => loadOpenAICompatibleConfigFromEnv({
      OPENAI_COMPATIBLE_BASE_URL: 'http://model.local/v1',
      OPENAI_COMPATIBLE_API_KEY: 'test-only',
      OPENAI_COMPATIBLE_MODEL: 'model-a',
    })).toThrow('必须使用HTTPS');
  });
});
