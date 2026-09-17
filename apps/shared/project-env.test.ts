import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readProjectEnv } from './project-env';

describe('项目运行配置隔离', () => {
  it('本地POC覆盖机器人身份但保留本项目模型配置，显式其他文件不受覆盖', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'assistant-local-env-'));
    mkdirSync(path.join(directory, '.runtime'));
    writeFileSync(path.join(directory, '.runtime/wecom.env'), 'WECOM_BOT_ID=previous\nAGENT_PROVIDER=ark\n');
    writeFileSync(path.join(directory, '.runtime/local-poc.env'), 'WECOM_BOT_ID=current\nGATEWAY_ENABLED=false\n');
    const other = path.join(directory, 'other.env');
    writeFileSync(other, 'WECOM_BOT_ID=explicit\n');
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(directory);
    try {
      expect(readProjectEnv()).toMatchObject({ WECOM_BOT_ID: 'current', AGENT_PROVIDER: 'ark', GATEWAY_ENABLED: 'false' });
      expect(readProjectEnv(other)).toEqual({ WECOM_BOT_ID: 'explicit' });
    } finally { cwd.mockRestore(); rmSync(directory, { recursive: true, force: true }); }
  });
  it('不合并系统或用户级环境变量', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'assistant-env-'));
    const envFile = path.join(directory, 'wecom.env');
    writeFileSync(envFile, 'WECOM_BOT_ID=project-bot\n', 'utf8');
    const globalKey = ['ARK', 'API', 'KEY'].join('_');
    const previous = process.env[globalKey];
    process.env[globalKey] = 'global-key-must-not-leak';
    try {
      const result = readProjectEnv(envFile);
      expect(result.WECOM_BOT_ID).toBe('project-bot');
      expect(result.ARK_API_KEY).toBeUndefined();
    } finally {
      if (previous == null) delete process.env[globalKey];
      else process.env[globalKey] = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
