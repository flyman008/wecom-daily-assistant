import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 只解析当前项目显式指定的环境文件，不把用户/系统全局环境合并进来。
 * 这是新旧企业以及本项目与全局开发工具之间的硬隔离边界。
 */
export function readProjectEnv(envFile = path.resolve('.runtime/wecom.env')): NodeJS.ProcessEnv {
  const result = parseEnvFile(envFile);
  if (path.resolve(envFile) === path.resolve('.runtime/wecom.env')) {
    Object.assign(result, parseEnvFile(path.resolve('.runtime/local-poc.env')));
    Object.assign(result, parseEnvFile(path.resolve('.runtime/deepseek.env')));
    Object.assign(result, parseEnvFile(path.resolve('.runtime/local-run.env')));
  }
  return result;
}

function parseEnvFile(envFile: string): NodeJS.ProcessEnv {
  if (!existsSync(envFile)) return {};
  const result: NodeJS.ProcessEnv = {};
  for (const sourceLine of readFileSync(envFile, 'utf8').split(/\r?\n/u)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[match[1]] = value;
  }
  return result;
}
