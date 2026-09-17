import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createConfiguredAgent, type AgentTaskRequest } from '@wecom/agent';
import { readProjectEnv } from '../../shared/project-env';

const projectEnv = readProjectEnv();
const host = projectEnv.AGENT_HOST ?? '127.0.0.1';
const port = Number(projectEnv.AGENT_PORT ?? 8790);
const internalKey = projectEnv.AGENT_INTERNAL_KEY?.trim() ?? '';
if (!internalKey) throw new Error('缺少AGENT_INTERNAL_KEY');

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}

async function readRequest(req: IncomingMessage): Promise<AgentTaskRequest> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 2 * 1024 * 1024) throw new Error('请求体过大');
    chunks.push(buffer);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as AgentTaskRequest;
  const allowed = ['daily_record_extract', 'daily_summary_draft', 'weekly_report_generate', 'manager_feedback_parse', 'quality_review'];
  if (value?.schemaVersion !== 1 || !value.requestId || !value.tenantId || !allowed.includes(value.taskType)) throw new Error('Agent任务格式无效');
  return value;
}

const configured = createConfiguredAgent(projectEnv);
const agent = configured.agent;
const server = createServer(async (req, res) => {
  if (req.url === '/health') return send(res, 200, {
    ok: true,
    runtime: configured.provider,
    provider: configured.provider,
    model: configured.model,
    state: 'stateless',
  });
  if (req.url !== '/v1/tasks' || req.method !== 'POST') return send(res, 404, { error: 'not_found' });
  const presented = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
  if (!equal(presented, internalKey)) return send(res, 401, { error: 'unauthorized' });
  try {
    const request = await readRequest(req);
    const result = await agent.run(request);
    return send(res, 200, result);
  } catch (error) {
    return send(res, 400, { error: error instanceof Error ? error.message : 'agent_failed' });
  }
});

server.listen(port, host, () => console.log(`Agent服务：http://${host}:${port}`));
