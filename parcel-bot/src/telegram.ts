import { SafeError } from './domain.ts';
import { type Message, Store } from './store.ts';

export interface TelegramUser { id: number; first_name: string; last_name?: string; is_bot?: boolean; }
export interface TelegramMessage { message_id: number; chat: { id: number; type: string }; from?: TelegramUser; text?: string; }
export interface Update { update_id: number; message?: TelegramMessage; callback_query?: { id: string; from: TelegramUser; message?: TelegramMessage; data?: string }; }
export class TelegramError extends SafeError {
  constructor(readonly code: number, seconds?: number) { super(`텔레그램 요청 실패 (코드 ${code}).`, seconds); }
}
export interface TelegramSender { send(chatId: number, message: Message): Promise<void>; }
export class Telegram implements TelegramSender {
  constructor(private readonly token: string, private readonly fetcher: typeof fetch = fetch) {}
  async call<T>(method: string, body: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try { response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(20_000),
    }); } catch { throw new SafeError('텔레그램 서버에 연결하지 못했습니다.'); }
    let result: { ok: boolean; result: T; error_code?: number; parameters?: { retry_after?: number } };
    try { result = await response.json() as typeof result; }
    catch { throw new SafeError('텔레그램 응답을 읽지 못했습니다.'); }
    if (!result.ok) throw new TelegramError(result.error_code ?? response.status, result.parameters?.retry_after);
    return result.result;
  }
  async initialize(): Promise<void> {
    await this.call('getMe');
    const info = await this.call<{ url?: string }>('getWebhookInfo');
    if (info.url) throw new SafeError('기존 텔레그램 webhook이 설정되어 있습니다. 해당 봇의 기존 연결을 해제하거나 별도 봇 토큰을 사용해주세요.');
    await this.call('setMyCommands', { commands: [
      ['start', '사용 신청 및 시작'], ['help', '사용법'], ['add', '택배 등록'], ['list', '내 택배 목록'],
      ['track', '즉시 조회'], ['history', '배송 이력'], ['rename', '별명 변경'], ['pause', '추적 중지'],
      ['resume', '추적 재개'], ['remove', '등록 삭제'], ['cancel', '입력 취소'], ['status', '조회 상태'], ['whoami', '내 사용자 ID'],
    ].map(([command, description]) => ({ command, description })) });
  }
  updates(offset: number, signal: AbortSignal): Promise<Update[]> { return this.call('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'callback_query'] }, signal); }
  async answer(id: string): Promise<void> { await this.call('answerCallbackQuery', { callback_query_id: id }); }
  async send(chatId: number, message: Message): Promise<void> { await this.call('sendMessage', { chat_id: chatId, ...message, link_preview_options: { is_disabled: true } }); }
}

export class Dispatcher {
  constructor(private readonly store: Store, private readonly telegram: TelegramSender, private readonly now = Date.now) {}
  async tick(stopping: () => boolean = () => false): Promise<void> {
    const rateLimit = Number(this.store.meta('telegram_send_after') ?? '0');
    if (rateLimit > this.now()) return;
    for (const item of this.store.pending(this.now())) {
      if (stopping()) break;
      const user = this.store.user(item.user_id);
      if (!user || (item.kind !== 'access' && user.status !== 'approved') || this.store.meta(`unreachable:${item.user_id}`) === '1') { this.store.cancel(item.id); continue; }
      if (item.subscription_id !== null) {
        try {
          const sub = this.store.subscription(user.id, item.subscription_id);
          // Pausing delays already queued notifications; resuming delivers them in order.
          if (item.kind === 'delivery' && sub.mode === 'paused') { this.store.defer(item.id, this.now() + 60_000); continue; }
        } catch { this.store.cancel(item.id); continue; }
      }
      try { await this.telegram.send(user.chat_id, JSON.parse(item.payload) as Message); this.store.sent(item.id, this.now()); }
      catch (error) {
        if (error instanceof TelegramError && error.code === 403) {
          this.store.setMeta(`unreachable:${user.id}`, '1'); this.store.cancel(item.id);
        } else if (error instanceof TelegramError && error.code === 400) {
          this.store.cancel(item.id);
          console.error('텔레그램 메시지 형식 오류로 발송 1건을 중단했습니다.');
        } else {
          const seconds = error instanceof SafeError ? error.retryAfterSeconds : undefined;
          this.store.retry(item.id, this.now(), seconds);
          if (error instanceof TelegramError && error.code === 429) {
            this.store.setMeta('telegram_send_after', String(this.now() + (seconds ?? 30) * 1000)); return;
          }
        }
      }
    }
  }
}
