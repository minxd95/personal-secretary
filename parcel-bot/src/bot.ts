import { SafeError, eventLine, safeError } from './domain.ts';
import { type Button, type Conversation, type Message, Store, summary, title } from './store.ts';
import { TrackingService } from './service.ts';
import type { Update } from './telegram.ts';

const HELP = `📦 배송조회 봇\n/add cj 운송장번호 [별명] — 등록\nCJ 123456789012 운동화 — 한 줄 등록\n/add — 단계별 등록\n/list [all] — 추적 중 / 전체 목록\n/track [ID] — 즉시 조회\n/history [ID] — 배송 이력\n/rename ID 별명 — 별명 변경\n/pause [ID] · /resume [ID] — 중지·재개\n/remove [ID] — 확인 후 삭제\n/status — 내 조회 상태\n/cancel — 입력 취소\n/whoami — 내 사용자 ID\n\n15분마다 확인하고 변경 시 알려드립니다. 배송 완료 시 자동 종료합니다. 맥이 잠자기 상태이면 깨어난 뒤 재개합니다.`;
const buttons = (rows: Button[][]): Pick<Message, 'reply_markup'> => ({ reply_markup: { inline_keyboard: rows } });
const button = (text: string, callback_data: string): Button => ({ text, callback_data });
interface Job { id: string; user_id: number; subscription_id: number; kind: string; }

export class Bot {
  constructor(readonly store: Store, readonly service: TrackingService, readonly adminId?: number) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
      subscription_id INTEGER NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE, kind TEXT NOT NULL
    )`);
    if (adminId) store.ensureUser(adminId, adminId, '관리자', adminId);
  }
  private job(id: string, userId: number, subscriptionId: number, kind: string): void {
    this.store.db.prepare('INSERT OR IGNORE INTO jobs VALUES (?, ?, ?, ?)').run(id, userId, subscriptionId, kind);
  }
  handle(update: Update): void {
    if (update.update_id < Number(this.store.meta('telegram_offset') ?? '0')) return;
    // All command mutations, replies, jobs, wizard state and offset commit together.
    this.store.transaction(() => {
      const message = update.message ?? update.callback_query?.message;
      const from = update.callback_query?.from ?? update.message?.from;
      if (!message || message.chat.type !== 'private' || !from || from.is_bot || message.chat.id !== from.id) {
        this.store.setMeta('telegram_offset', String(update.update_id + 1)); return;
      }
      const userId = from.id;
      this.store.ensureUser(userId, message.chat.id, `${from.first_name} ${from.last_name ?? ''}`.trim(), this.adminId);
      this.store.setMeta(`unreachable:${userId}`, '0');
      let replyIndex = 0;
      const reply = (text: string, extra: Partial<Message> = {}, kind = 'reply', subId: number | null = null): void => {
        this.store.queue(`update:${update.update_id}:${replyIndex++}`, userId, { text, ...extra }, kind, subId);
      };
      const raw = (update.message?.text ?? '').trim();
      const callback = update.callback_query?.data;
      try {
        let [command = '', ...args] = raw.split(/\s+/);
        command = command.toLowerCase().split('@')[0]!;
        if (callback) {
          const [action, value] = callback.split(':');
          if (!action || !/^[a-z]+$/.test(action)) throw new SafeError('지원하지 않는 버튼입니다.');
          command = `/${action}`; args = value === undefined ? [] : [value];
        }
        if (command === '/whoami') { reply(`내 텔레그램 ID: ${userId}`, {}, 'access'); }
        else if (!this.adminId) { reply('관리자 설정 대기 중입니다. /whoami로 ID를 확인해 로컬 .env의 ADMIN_TELEGRAM_ID에 입력해주세요.', {}, 'access'); }
        else if (this.store.user(userId)!.status === 'blocked') { reply('봇 사용이 제한된 계정입니다. 관리자에게 문의해주세요.', {}, 'access'); }
        else if (this.store.user(userId)!.status !== 'approved') {
          if (command === '/start' || command === '/help') {
            this.store.queue(`access-request:${userId}`, this.adminId, { text: `사용 신청: ${from.first_name}\n사용자 ID: ${userId}`, ...buttons([[button('승인', `approve:${userId}`), button('거절', `block:${userId}`)]]) });
          }
          reply('관리자 승인이 필요합니다. /start로 신청해주세요. 이미 신청했다면 승인 후 안내드립니다.', {}, 'access');
        } else {
          const conversation = this.store.conversation(userId);
          if (!callback && !raw.startsWith('/') && conversation) this.converse(userId, raw, conversation, update.update_id, reply);
          else if (command === '/start' || command === '/help') reply(HELP + (userId === this.adminId ? '\n\n관리자: /users · /approve ID · /block ID' : ''));
          else if (command === '/cancel') { this.store.clearConversation(userId); reply('진행 중인 입력을 취소했습니다.'); }
          else if (command === '/add') {
            if (!args.length) { this.conversation(userId, { step: 'carrier' }); reply('택배사를 선택해주세요.', buttons(this.service.carriers.map(carrier => [button(carrier.name, `carrier:${carrier.id}`)]))); }
            else this.add(userId, args, update.update_id, reply);
          } else if (command === '/carrier') {
            const carrier = this.service.carrier(args[0] ?? '');
            this.conversation(userId, { step: 'number', carrier: carrier.id }); reply('운송장번호를 입력해주세요. 공백과 하이픈은 제거합니다.');
          } else if (command === '/skip') {
            if (conversation?.step !== 'alias') throw new SafeError('진행 중인 등록이 없습니다. /add로 시작해주세요.');
            this.finishAdd(userId, conversation.carrier!, conversation.number!, '', update.update_id, reply);
          } else if (command === '/list') {
            const subs = this.store.subscriptions(userId, args[0] === 'all');
            if (!subs.length) reply('표시할 택배가 없습니다. /add로 등록하거나 /list all로 확인해주세요.');
            for (const sub of subs) reply(`${summary(sub)}\n추적: ${sub.mode === 'active' ? '진행 중' : sub.mode === 'paused' ? '일시중지' : '완료'}`, buttons([
              [button('조회', `track:${sub.id}`), button('이력', `history:${sub.id}`)],
              [...(sub.mode === 'done' ? [] : [button(sub.mode === 'paused' ? '재개' : '중지', `${sub.mode === 'paused' ? 'resume' : 'pause'}:${sub.id}`)]), button('삭제', `remove:${sub.id}`)],
            ]), 'reply', sub.id);
          } else if (['/track', '/history', '/rename', '/pause', '/resume', '/remove', '/confirmremove'].includes(command)) {
            if (!args.length) {
              const subs = this.store.subscriptions(userId);
              if (!subs.length) reply('등록된 택배가 없습니다. /add로 등록해주세요.');
              else { reply('택배를 선택해주세요.'); for (let i = 0; i < subs.length; i += 20) reply('내 택배', buttons(subs.slice(i, i + 20).map(sub => [button(`#${sub.id} ${sub.alias || sub.number}`, `${command.slice(1)}:${sub.id}`)]))); }
            } else {
              const id = this.id(args[0]!);
              const sub = this.store.subscription(userId, id);
              if (command === '/track') { this.job(`manual:${update.update_id}`, userId, id, 'manual'); reply('조회 요청을 접수했습니다. 60초 이내 조회 결과는 재사용합니다.', {}, 'reply', id); }
              if (command === '/history') {
                const events = this.store.events(sub.shipment_id);
                reply(`${title(sub)}\n\n${events.length ? events.map(eventLine).join('\n\n') : '아직 배송 이력이 없습니다.'}`, {}, 'reply', id);
              }
              if (command === '/rename') {
                if (args.length < 2) { this.conversation(userId, { step: 'rename', subscriptionId: id }); reply('새 별명을 입력해주세요.'); }
                else { this.store.rename(userId, id, args.slice(1).join(' ')); reply('별명을 변경했습니다.'); }
              }
              if (command === '/pause' || command === '/resume') { this.store.mode(userId, id, command === '/pause' ? 'paused' : 'active'); reply(command === '/pause' ? '자동 조회와 알림을 일시중지했습니다.' : '자동 조회를 재개했습니다. 중지 중 새로 확인된 이력도 전달합니다.'); }
              if (command === '/remove') reply(`${title(sub)}\n내 목록에서 삭제할까요?`, buttons([[button('삭제 확인', `confirmremove:${id}`), button('취소', 'cancel')]]), 'reply', id);
              if (command === '/confirmremove') { if (!callback) throw new SafeError('/remove 명령의 삭제 확인 버튼을 눌러주세요.'); this.store.remove(userId, id); reply('내 목록과 해당 알림을 삭제했습니다.'); }
            }
          } else if (command === '/status') {
            const subs = this.store.subscriptions(userId);
            reply(`내 택배 ${subs.length}개 · 추적 중 ${subs.filter(sub => sub.mode === 'active').length}개\n기본 조회 주기 ${this.service.intervalMs / 60_000}분\n${subs.map(sub => summary(sub)).join('\n\n') || '등록된 택배가 없습니다.'}`);
          } else if (['/users', '/approve', '/block'].includes(command)) {
            if (userId !== this.adminId) throw new SafeError('관리자 전용 명령입니다.');
            if (command === '/users') reply(this.store.users().map(user => `${user.id} · ${user.name} · ${user.status}`).join('\n'));
            else {
              const target = this.id(args[0] ?? '');
              if (target === this.adminId) throw new SafeError('관리자 권한은 변경할 수 없습니다.');
              const status = command === '/approve' ? 'approved' : 'blocked';
              const oldStatus = this.store.user(target)?.status;
              this.store.setUserStatus(target, status);
              if (oldStatus !== status) this.store.queue(`permission:${update.update_id}`, target, { text: status === 'approved' ? '사용이 승인되었습니다! /help로 시작하세요.' : '사용 신청이 거절되었거나 사용이 차단되었습니다.' }, 'access');
              reply(`${target}: ${status === 'approved' ? '승인' : '차단'}했습니다.`);
            }
          } else if (!raw.startsWith('/') && this.service.carriers.some(carrier => carrier.aliases.includes(command))) this.add(userId, [command, ...args], update.update_id, reply);
          else reply('명령을 이해하지 못했습니다. /help에서 사용법을 확인해주세요.');
        }
      } catch (error) {
        if (!(error instanceof SafeError)) throw error;
        reply(safeError(error), {}, this.store.user(userId)?.status === 'approved' ? 'reply' : 'access');
      }
      this.store.setMeta('telegram_offset', String(update.update_id + 1));
    });
  }
  private id(value: string): number { if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) throw new SafeError('숫자 ID를 입력해주세요. /list 또는 /whoami로 확인할 수 있습니다.'); return Number(value); }
  private conversation(userId: number, value: Omit<Conversation, 'expires'>): void { this.store.setConversation(userId, { ...value, expires: Date.now() + 15 * 60_000 }); }
  private converse(userId: number, raw: string, state: Conversation, updateId: number, reply: (text: string, extra?: Partial<Message>) => void): void {
    if (state.step === 'carrier') { const carrier = this.service.carrier(raw); this.conversation(userId, { step: 'number', carrier: carrier.id }); reply('운송장번호를 입력해주세요.'); }
    if (state.step === 'number') {
      const number = this.service.carrier(state.carrier!).normalize(raw);
      this.conversation(userId, { step: 'alias', carrier: state.carrier, number }); reply('택배 별명을 입력하거나 건너뛰기를 눌러주세요.', buttons([[button('건너뛰기', 'skip')]]));
    }
    if (state.step === 'alias') this.finishAdd(userId, state.carrier!, state.number!, raw, updateId, reply);
    if (state.step === 'rename') { this.store.rename(userId, state.subscriptionId!, raw); this.store.clearConversation(userId); reply('별명을 변경했습니다.'); }
  }
  private add(userId: number, args: string[], updateId: number, reply: (text: string, extra?: Partial<Message>) => void): void {
    const carrier = this.service.carrier(args[0] ?? '');
    if (!args[1]) throw new SafeError('예: /add cj 123456789012 운동화');
    // Quoted/spaced numbers are best entered in the dedicated number step; one-line syntax uses one token.
    this.finishAdd(userId, carrier.id, carrier.normalize(args[1]), args.slice(2).join(' '), updateId, reply);
  }
  private finishAdd(userId: number, carrier: string, number: string, alias: string, updateId: number, reply: (text: string) => void): void {
    if (alias.length > 100) throw new SafeError('별명은 100자 이내로 입력해주세요.');
    const shipment = this.store.ensureShipment(carrier, number);
    const { subscription: sub, created } = this.store.add(userId, shipment.id, alias);
    this.store.clearConversation(userId);
    if (!created) { reply(`이미 등록된 택배입니다.\n${summary(sub)}`); return; }
    reply(`등록했습니다.\n${summary(sub)}`);
    if (sub.mode !== 'done') this.job(`initial:${updateId}`, userId, sub.id, 'initial');
  }
  async jobs(stopping: () => boolean = () => false): Promise<void> {
    const jobs = this.store.db.prepare('SELECT * FROM jobs ORDER BY rowid LIMIT 20').all() as unknown as Job[];
    for (const job of jobs) {
      if (stopping()) break;
      if (this.store.user(job.user_id)?.status !== 'approved') { this.store.db.prepare('DELETE FROM jobs WHERE id = ?').run(job.id); continue; }
      let text: string | undefined;
      try {
        const sub = this.store.subscription(job.user_id, job.subscription_id);
        await this.service.refresh(sub.shipment_id);
        if (job.kind === 'manual') text = summary(this.store.subscription(job.user_id, job.subscription_id));
      } catch (error) { text = `조회 안내: ${safeError(error)}\n기존 등록은 유지됩니다.`; }
      this.store.transaction(() => {
        if (text && this.store.db.prepare('SELECT 1 FROM subscriptions WHERE id = ? AND user_id = ?').get(job.subscription_id, job.user_id)) this.store.queue(`job:${job.id}`, job.user_id, { text }, 'reply', job.subscription_id);
        this.store.db.prepare('DELETE FROM jobs WHERE id = ?').run(job.id);
      });
    }
  }
}
