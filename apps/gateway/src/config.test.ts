import { describe, expect, it } from 'vitest';
import { loadGatewayConfig } from './config';

describe('企微网关配置隔离', () => {
  it('只使用显式传入的当前项目环境', () => {
    const config = loadGatewayConfig({
      WECOM_BOT_ID: 'new-company-bot',
      WECOM_BOT_SECRET: 'new-company-secret',
      DATABASE_PATH: '.runtime/test.sqlite',
      WEEK_BOUNDARY: 'work_week',
    });
    expect(config.botId).toBe('new-company-bot');
    expect(config.weekBoundary).toBe('work_week');
    expect(config.databasePath).toContain('test.sqlite');
  });

  it('缺少新企业凭证时直接失败', () => {
    expect(() => loadGatewayConfig({})).toThrow('WECOM_BOT_ID');
  });
});
