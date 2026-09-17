// 真 Agent demo：凭证只从本项目运行配置注入。
import { ArkAgent, loadArkConfigFromEnv } from '@wecom/agent';
import { readProjectEnv } from '../../shared/project-env';
import { runDemo } from './demo';

async function main() {
  try {
    const cfg = loadArkConfigFromEnv(readProjectEnv());
    console.log(`[真 Agent] model=${cfg.model} base=${cfg.baseUrl}`);
    await runDemo(':memory:', new ArkAgent(cfg));
  } catch (e) {
    console.error('运行失败：', e instanceof Error ? e.message : e);
    process.exit(1);
  }
}

void main();
