import { createHash } from 'node:crypto';

function sanitize(value: string): string {
  return value
    .replace(/(?:https?|wss):\/\/[^\s,]+/gi, '[url]')
    .replace(/\b(secret|aeskey|access_token|token|authorization)\s*[:=]\s*[^\s,]+/gi, '$1=[redacted]');
}

function emit(level: 'info' | 'warn' | 'error', message: string, details: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ time: new Date().toISOString(), level, message: sanitize(message), details });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  info: (message: string, details?: Record<string, unknown>) => emit('info', message, details),
  warn: (message: string, details?: Record<string, unknown>) => emit('warn', message, details),
  error: (message: string, error?: unknown, details: Record<string, unknown> = {}) => emit('error', message, {
    ...details,
    ...(error instanceof Error ? { error: sanitize(error.message), errorName: error.name } : {}),
  }),
};

export const sdkLogger = {
  debug: (message: string, ...args: unknown[]) => logger.info(sanitize(message), { argCount: args.length }),
  info: (message: string, ...args: unknown[]) => logger.info(sanitize(message), { argCount: args.length }),
  warn: (message: string, ...args: unknown[]) => logger.warn(sanitize(message), { argCount: args.length }),
  error: (message: string, ...args: unknown[]) => logger.error(sanitize(message), undefined, { argCount: args.length }),
};

export function privateLabel(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 10);
}
