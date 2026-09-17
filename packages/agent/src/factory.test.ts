import { describe, expect, it } from 'vitest';
import { createConfiguredAgent, loadAgentProvider } from './factory';

describe('Agent provider选择', () => {
  it('默认使用Mock，不需要真实密钥', () => {
    const configured = createConfiguredAgent({});
    expect(configured.provider).toBe('mock');
    expect(configured.model).toBeUndefined();
  });

  it('只有密钥但未显式选择Provider时仍保持Mock', () => {
    expect(loadAgentProvider({ ARK_API_KEY: 'unrelated-key' })).toBe('mock');
  });

  it('显式provider优先并对缺失配置快速失败', () => {
    expect(() => createConfiguredAgent({ AGENT_PROVIDER: 'ark' })).toThrow('ARK_BASE_URL');
    expect(() => createConfiguredAgent({ AGENT_PROVIDER: 'unknown' })).toThrow('AGENT_PROVIDER');
  });
});
