import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { createConfiguredAgent, HttpAgent, type Agent } from '@wecom/agent';
import { loadGatewayConfig, loadProjectEnv } from './config';
import { WeComGateway } from './gateway';
import { logger } from './logger';

const projectEnv = loadProjectEnv();
const config = loadGatewayConfig(projectEnv);
const runtimeDir = path.resolve('.runtime');
const pidPath = path.join(runtimeDir, 'gateway.pid');

function createAgent(): Agent {
  if (projectEnv.AGENT_SERVICE_URL?.trim()) {
    const apiKey = projectEnv.AGENT_INTERNAL_KEY?.trim();
    if (!apiKey) throw new Error('配置AGENT_SERVICE_URL时必须同时配置AGENT_INTERNAL_KEY');
    logger.info('使用独立Agent服务');
    return new HttpAgent({ baseUrl: projectEnv.AGENT_SERVICE_URL, apiKey });
  }
  const configured = createConfiguredAgent(projectEnv);
  if (configured.provider === 'mock') logger.warn('当前使用Mock Agent');
  else logger.info('使用LLM Agent', { provider: configured.provider, model: configured.model });
  return configured.agent;
}

async function main(): Promise<void> {
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(pidPath, `${process.pid}\n`, 'ascii');
  const gateway = new WeComGateway(config, createAgent());
  const health = createServer((_req, res) => {
    const database = (gateway.db.prepare('SELECT 1 AS ok').get() as { ok: number }).ok === 1;
    const body = JSON.stringify({
      ok: database && gateway.client.isConnected,
      connected: gateway.client.isConnected,
      database,
      activeTasks: gateway.activeTasks,
      time: new Date().toISOString(),
    });
    res.writeHead(database && gateway.client.isConnected ? 200 : 503, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  });
  health.listen(config.healthPort, '127.0.0.1');
  gateway.start();
  logger.info('日报助手企微网关已启动', { healthPort: config.healthPort });

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info('正在停止企微网关', { signal });
    gateway.stop();
    health.close(() => void rm(pidPath, { force: true }).finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 5_000).unref();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(async (error) => {
  logger.error('企微网关启动失败', error);
  await rm(pidPath, { force: true });
  process.exitCode = 1;
});
