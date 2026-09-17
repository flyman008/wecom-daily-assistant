import type { AgentTaskRequest, AgentStructuredResult } from './contracts';
import type { Agent } from './mock';
import { extractJson, validateAgentResult } from './ark';
import { buildAgentPrompt } from './prompt';
import {recordModelUsage} from './usage';

export interface OpenAICompatibleConfig {
  model: string;
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  maxTokens?: number;
}

function boundedNumber(raw: string | undefined, fallback: number, min: number, max: number, name: string): number {
  const value = raw === undefined || raw.trim() === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name}必须在${min}到${max}之间`);
  return value;
}

export function loadOpenAICompatibleConfigFromEnv(env: NodeJS.ProcessEnv = {}): OpenAICompatibleConfig {
  const model = env.OPENAI_COMPATIBLE_MODEL?.trim();
  const baseUrl = (env.OPENAI_COMPATIBLE_BASE_URL ?? '').trim().replace(/\/$/, '');
  const token = (env.OPENAI_COMPATIBLE_API_KEY ?? '').trim();
  if (!model) throw new Error('缺少 OPENAI_COMPATIBLE_MODEL');
  if (!baseUrl) throw new Error('缺少 OPENAI_COMPATIBLE_BASE_URL');
  if (!/^https:\/\//i.test(baseUrl) && env.NODE_ENV !== 'test') throw new Error('OPENAI_COMPATIBLE_BASE_URL必须使用HTTPS');
  if (!token) throw new Error('缺少 OPENAI_COMPATIBLE_API_KEY');
  return {
    model,
    baseUrl,
    token,
    timeoutMs: boundedNumber(env.OPENAI_COMPATIBLE_TIMEOUT_MS, 60_000, 1_000, 300_000, 'OPENAI_COMPATIBLE_TIMEOUT_MS'),
    maxTokens: boundedNumber(env.OPENAI_COMPATIBLE_MAX_TOKENS, 2_048, 256, 8_192, 'OPENAI_COMPATIBLE_MAX_TOKENS'),
  };
}

export class OpenAICompatibleAgent implements Agent {
  constructor(
    private readonly config: OpenAICompatibleConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async run(request: AgentTaskRequest, options: { signal?: AbortSignal } = {}): Promise<AgentStructuredResult> {
    let last:unknown;
    for(let attempt=0;attempt<2;attempt++) {
      try {return await this.runOnce(request,options,attempt+1);} catch(error) {
        last=error;
        if(options.signal?.aborted||/HTTP (?:400|401|403|404)/.test(error instanceof Error?error.message:''))throw error;
      }
    }
    throw last;
  }
  private async runOnce(request: AgentTaskRequest, options: { signal?: AbortSignal },attempt:number): Promise<AgentStructuredResult> {
    const prompt = buildAgentPrompt(request);
    const timeout = AbortSignal.timeout(this.config.timeoutMs ?? 60_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const response = await this.fetchFn(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.config.token}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        max_tokens: this.config.maxTokens ?? 2_048,
        temperature: 0.1,
        ...(this.config.model.startsWith('deepseek-v4')?{thinking:{type:'disabled'},response_format:{type:'json_object'}}:{}),
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
      }),
      signal,
    });
    const responseText = await response.text();
    if (!response.ok) throw new Error(`OpenAI-compatible请求失败：HTTP ${response.status}`);
    let body: { choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }> };
    try {
      body = JSON.parse(responseText) as typeof body;
    } catch {
      throw new Error('OpenAI-compatible返回了无效JSON');
    }
    recordModelUsage(request.taskType,this.config.model,(body as any).usage,attempt);
    const content = body.choices?.[0]?.message?.content;
    const output = typeof content === 'string'
      ? content
      : (content ?? []).filter((item) => item.type === 'text').map((item) => item.text ?? '').join('');
    if (!output) throw new Error('OpenAI-compatible未返回文本内容');
    return validateAgentResult(request, extractJson(output));
  }
}
