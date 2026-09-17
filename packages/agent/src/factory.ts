import { ArkAgent, loadArkConfigFromEnv } from './ark';
import type { Agent } from './mock';
import { MockAgent } from './mock';
import { OpenAICompatibleAgent, loadOpenAICompatibleConfigFromEnv } from './openai-compatible';
import { GuardedAgent } from './policy';

export type AgentProvider = 'mock' | 'ark' | 'openai_compatible';

export interface ConfiguredAgent {
  agent: Agent;
  provider: AgentProvider;
  model?: string;
}

export function loadAgentProvider(env: NodeJS.ProcessEnv = {}): AgentProvider {
  const explicit = env.AGENT_PROVIDER?.trim().toLowerCase();
  if (explicit) {
    if (!['mock', 'ark', 'openai_compatible'].includes(explicit)) {
      throw new Error('AGENT_PROVIDER必须是mock、ark或openai_compatible');
    }
    return explicit as AgentProvider;
  }
  // 新企业实例必须显式选择真实Provider，避免误用宿主机或旧项目遗留的密钥。
  return 'mock';
}

export function createConfiguredAgent(
  env: NodeJS.ProcessEnv = {},
  fetchFn: typeof fetch = fetch,
): ConfiguredAgent {
  const provider = loadAgentProvider(env);
  if (provider === 'mock') return { agent: new GuardedAgent(new MockAgent()), provider };
  if (provider === 'ark') {
    const config = loadArkConfigFromEnv(env);
    return { agent: new GuardedAgent(new ArkAgent(config, fetchFn)), provider, model: config.model };
  }
  const config = loadOpenAICompatibleConfigFromEnv(env);
  return { agent: new GuardedAgent(new OpenAICompatibleAgent(config, fetchFn)), provider, model: config.model };
}
