import type { AgentTaskRequest, AgentStructuredResult } from './contracts';
import type { Agent } from './mock';
import { validateAgentResult } from './ark';

export interface HttpAgentConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
}

export class HttpAgent implements Agent {
  constructor(
    private readonly config: HttpAgentConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async run(request: AgentTaskRequest, options: { signal?: AbortSignal } = {}): Promise<AgentStructuredResult> {
    const timeout = AbortSignal.timeout(this.config.timeoutMs ?? 90_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const response = await this.fetchFn(`${this.config.baseUrl.replace(/\/$/, '')}/v1/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.config.apiKey}` },
      body: JSON.stringify(request),
      signal,
    });
    if (!response.ok) throw new Error(`Agent服务请求失败：HTTP ${response.status}`);
    const body = await response.json() as { taskType?: string; result?: unknown };
    if (body.taskType !== request.taskType) throw new Error('Agent服务返回了错误的任务类型');
    return validateAgentResult(request, body.result);
  }
}
