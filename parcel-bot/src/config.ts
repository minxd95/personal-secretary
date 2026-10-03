import { resolve } from 'node:path';
import { SafeError } from './domain.ts';
export interface Config { token: string; adminId?: number; database: string; intervalMs: number; gapMs: number; timeoutMs: number; }
export function config(env: NodeJS.ProcessEnv = process.env): Config {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new SafeError('Node.js 24로 실행해주세요.');
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new SafeError('.env에 TELEGRAM_BOT_TOKEN을 입력해주세요.');
  const admin = env.ADMIN_TELEGRAM_ID?.trim();
  if (admin && (!/^\d+$/.test(admin) || !Number.isSafeInteger(Number(admin)) || Number(admin) < 1)) throw new SafeError('ADMIN_TELEGRAM_ID는 양의 정수여야 합니다.');
  const number = (key: string, defaultValue: number, min: number, max: number): number => {
    const value = env[key]?.trim() ? Number(env[key]) : defaultValue;
    if (!Number.isInteger(value) || value < min || value > max) throw new SafeError(`${key}는 ${min}~${max} 범위의 정수여야 합니다.`);
    return value;
  };
  return { token, adminId: admin ? Number(admin) : undefined, database: resolve(env.DATABASE_PATH || './data/parcel-bot.sqlite'),
    intervalMs: number('POLL_INTERVAL_MINUTES', 15, 1, 1440) * 60_000,
    gapMs: number('CJ_REQUEST_GAP_MS', 2000, 2000, 60_000), timeoutMs: number('REQUEST_TIMEOUT_MS', 15_000, 1000, 60_000) };
}
