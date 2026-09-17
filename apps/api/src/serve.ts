import path from 'node:path';
import { readProjectEnv } from '../../shared/project-env';
import { startServer } from './server';
import { createConfiguredAgent, HttpAgent, MockAgent } from '@wecom/agent';

function bool(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
}

const projectEnv = readProjectEnv();

const accessCode = projectEnv.POC_ACCESS_CODE ?? '';
if (!accessCode) throw new Error('请在当前项目环境中设置 POC_ACCESS_CODE');

const root = process.cwd();
const demoMode=bool(projectEnv.DEMO_MODE);
// Web-triggered generation uses the same configured runtime as the WeCom gateway.
// Tests/previews supply a Mock explicitly and never read production configuration.
if(projectEnv.AGENT_SERVICE_URL?.trim()&&!projectEnv.AGENT_INTERNAL_KEY?.trim()) throw new Error('配置AGENT_SERVICE_URL时必须同时配置AGENT_INTERNAL_KEY');
const agent=demoMode?new MockAgent():projectEnv.AGENT_SERVICE_URL?.trim()
  ?new HttpAgent({baseUrl:projectEnv.AGENT_SERVICE_URL,apiKey:projectEnv.AGENT_INTERNAL_KEY!})
  :createConfiguredAgent(projectEnv).agent;
void startServer({
  directoryEnv: projectEnv,
  agent,
  port: Number(projectEnv.PORT ?? 3000),
  host: projectEnv.API_HOST ?? '127.0.0.1',
  dbPath: projectEnv.DATABASE_PATH ?? path.join(root, '.runtime', 'data', 'poc.sqlite'),
  accessCode,
  allowedOrigins: (projectEnv.API_ALLOWED_ORIGINS ?? 'http://127.0.0.1:3000,http://localhost:3000')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  publicWeeklyUserName: projectEnv.PUBLIC_WEEKLY_USER_NAME,
  publicWeeklyEmployeeName: projectEnv.PUBLIC_WEEKLY_EMPLOYEE_NAME,
  demoMode,
  weekBoundary: projectEnv.WEEK_BOUNDARY,
});
