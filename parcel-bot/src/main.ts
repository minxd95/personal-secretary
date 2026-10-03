import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { config } from './config.ts';
import { SafeError, safeError } from './domain.ts';
import { acquireLock } from './lock.ts';
import { Store } from './store.ts';
import { CjCarrier } from './carriers/cj.ts';
import { TrackingService } from './service.ts';
import { Bot } from './bot.ts';
import { Dispatcher, Telegram, TelegramError } from './telegram.ts';

async function main(): Promise<void> {
  const settings = config();
  mkdirSync(dirname(settings.database), { recursive: true, mode: 0o700 });
  const release = acquireLock(`${settings.database}.lock`);
  let store: Store | undefined;
  const shutdown = new AbortController();
  const stop = (): void => { shutdown.abort(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const wait = async (ms: number): Promise<void> => { try { await sleep(ms, undefined, { signal: shutdown.signal }); } catch { /* shutdown */ } };
  try {
    store = new Store(settings.database);
    chmodSync(settings.database, 0o600);
    const service = new TrackingService(store, [new CjCarrier(settings.gapMs, settings.timeoutMs)], settings.intervalMs);
    const bot = new Bot(store, service, settings.adminId);
    const telegram = new Telegram(settings.token);
    let initializationFailures = 0;
    while (!shutdown.signal.aborted) {
      try { await telegram.initialize(); break; }
      catch (error) {
        if (error instanceof TelegramError && [401, 404].includes(error.code)) throw new SafeError('텔레그램 봇 토큰이 유효하지 않습니다. .env를 확인해주세요.');
        if (error instanceof SafeError && error.message.includes('webhook')) throw error;
        console.error(safeError(error));
        await wait(Math.min(60_000, 1000 * 2 ** Math.min(initializationFailures++, 6)));
      }
    }
    if (shutdown.signal.aborted) return;
    const dispatcher = new Dispatcher(store, telegram);
    console.info(settings.adminId ? '배송조회 봇을 시작했습니다.' : '설정 모드: 텔레그램에서 /whoami 후 관리자 ID를 .env에 입력하고 재시작하세요.');
    const updates = async (): Promise<void> => {
      let failures = 0;
      while (!shutdown.signal.aborted) {
        try {
          const batch = await telegram.updates(Number(store!.meta('telegram_offset') ?? '0'), shutdown.signal);
          for (const update of batch) {
            if (shutdown.signal.aborted) break;
            bot.handle(update);
            if (update.callback_query) { try { await telegram.answer(update.callback_query.id); } catch { /* Expired button acknowledgement does not replay the command. */ } }
          }
          failures = 0;
        } catch (error) {
          if (shutdown.signal.aborted) break;
          if (error instanceof TelegramError && [401, 409].includes(error.code)) {
            console.error('텔레그램 인증 또는 중복 polling 충돌입니다. 토큰과 다른 봇 프로세스를 확인해주세요.'); stop(); process.exitCode = 78; break;
          }
          console.error(safeError(error));
          await wait(Math.max((error instanceof SafeError ? error.retryAfterSeconds ?? 0 : 0) * 1000, Math.min(60_000, 1000 * 2 ** Math.min(failures++, 6))));
        }
      }
    };
    const deliveries = async (): Promise<void> => {
      while (!shutdown.signal.aborted) {
        try { if (settings.adminId) { await bot.jobs(() => shutdown.signal.aborted); if (!shutdown.signal.aborted) await service.poll(() => shutdown.signal.aborted); } }
        catch (error) { console.error(safeError(error)); }
        await wait(1000);
      }
    };
    const notifications = async (): Promise<void> => {
      while (!shutdown.signal.aborted) {
        try { await dispatcher.tick(() => shutdown.signal.aborted); } catch (error) { console.error(safeError(error)); }
        await wait(1100);
      }
    };
    await Promise.all([updates(), deliveries(), notifications()]);
    await service.drain();
  } finally {
    store?.close(); release();
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}
main().catch(error => { console.error(safeError(error)); process.exitCode = error instanceof SafeError ? 78 : 1; });
