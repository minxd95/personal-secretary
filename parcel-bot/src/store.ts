import { DatabaseSync } from 'node:sqlite';
import { eventLine, formatTime, carrierNames, type DeliveryEvent, type TrackingResult, SafeError } from './domain.ts';

export type UserStatus = 'pending' | 'approved' | 'blocked';
export interface User { id: number; chat_id: number; name: string; status: UserStatus; }
export interface Shipment {
  id: number; carrier: string; number: string; snapshot: string | null; checked_at: number | null;
  next_check: number; failures: number; last_error: string | null; revision: number;
}
export interface Subscription {
  id: number; user_id: number; shipment_id: number; alias: string; mode: 'active' | 'paused' | 'done';
  initialized: number; last_state: string | null; error_notified: number;
  carrier: string; number: string; snapshot: string | null; checked_at: number | null; last_error: string | null;
}
export interface Button { text: string; callback_data: string; }
export interface Message { text: string; reply_markup?: { inline_keyboard: Button[][] }; }
export interface Outbox { id: number; user_id: number; subscription_id: number | null; kind: string; payload: string; attempts: number; }
export interface Conversation { step: 'carrier' | 'number' | 'alias' | 'rename'; carrier?: string; number?: string; subscriptionId?: number; expires: number; }

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version > 1) throw new SafeError('이 DB는 더 최신 버전의 봇에서 생성되었습니다.');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS shipments (
        id INTEGER PRIMARY KEY AUTOINCREMENT, carrier TEXT NOT NULL, number TEXT NOT NULL,
        snapshot TEXT, checked_at INTEGER, next_check INTEGER NOT NULL DEFAULT 0,
        failures INTEGER NOT NULL DEFAULT 0, last_error TEXT, revision INTEGER NOT NULL DEFAULT 0,
        UNIQUE(carrier, number)
      );
      CREATE TABLE IF NOT EXISTS subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id),
        shipment_id INTEGER NOT NULL REFERENCES shipments(id), alias TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'active', initialized INTEGER NOT NULL DEFAULT 0,
        last_state TEXT, error_notified INTEGER NOT NULL DEFAULT 0, UNIQUE(user_id, shipment_id)
      );
      CREATE TABLE IF NOT EXISTS events (
        shipment_id INTEGER NOT NULL REFERENCES shipments(id) ON DELETE CASCADE, key TEXT NOT NULL,
        payload TEXT NOT NULL, PRIMARY KEY(shipment_id, key)
      );
      CREATE TABLE IF NOT EXISTS seen (
        subscription_id INTEGER NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
        event_key TEXT NOT NULL, PRIMARY KEY(subscription_id, event_key)
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT, dedupe TEXT NOT NULL UNIQUE,
        user_id INTEGER NOT NULL REFERENCES users(id), subscription_id INTEGER REFERENCES subscriptions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        available_at INTEGER NOT NULL DEFAULT 0, sent_at INTEGER, cancelled INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS outbox_due ON outbox(sent_at, cancelled, available_at);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations (user_id INTEGER PRIMARY KEY REFERENCES users(id), payload TEXT NOT NULL);
      PRAGMA user_version = 1;
    `);
  }
  close(): void { this.db.close(); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  meta(key: string): string | undefined { return (this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value; }
  setMeta(key: string, value: string): void { this.db.prepare('INSERT INTO meta VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value); }
  user(id: number): User | undefined { return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as User | undefined; }
  ensureUser(id: number, chatId: number, name: string, adminId: number | undefined): boolean {
    const previous = this.user(id);
    this.db.prepare(`INSERT INTO users VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET chat_id = excluded.chat_id, name = excluded.name`).run(id, chatId, name.slice(0, 100), id === adminId ? 'approved' : 'pending');
    if (id === adminId) this.db.prepare("UPDATE users SET status = 'approved' WHERE id = ?").run(id);
    return !previous;
  }
  users(): User[] { return this.db.prepare('SELECT * FROM users ORDER BY id').all() as unknown as User[]; }
  setUserStatus(id: number, status: UserStatus): void {
    if (!this.user(id)) throw new SafeError('먼저 봇에서 /start를 실행한 사용자만 처리할 수 있습니다.');
    this.db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, id);
    if (status === 'blocked') {
      this.db.prepare("UPDATE outbox SET cancelled = 1 WHERE user_id = ? AND sent_at IS NULL").run(id);
      this.clearConversation(id);
    }
  }
  queue(key: string, userId: number, message: Message, kind = 'reply', subscriptionId: number | null = null): void {
    // Every chunk is durable and independently retried; Telegram accepts at most 4096 characters.
    const chunks = splitText(message.text, 3500);
    chunks.forEach((text, index) => {
      const payload: Message = { text };
      if (index === chunks.length - 1 && message.reply_markup) payload.reply_markup = message.reply_markup;
      this.db.prepare('INSERT OR IGNORE INTO outbox(dedupe, user_id, subscription_id, kind, payload) VALUES (?, ?, ?, ?, ?)')
        .run(`${key}:${index}`, userId, subscriptionId, kind, JSON.stringify(payload));
    });
  }
  pending(now: number): Outbox[] { return this.db.prepare('SELECT o.* FROM outbox o WHERE o.sent_at IS NULL AND o.cancelled = 0 AND o.available_at <= ? AND NOT EXISTS (SELECT 1 FROM outbox earlier WHERE earlier.user_id = o.user_id AND earlier.kind = o.kind AND COALESCE(earlier.subscription_id, 0) = COALESCE(o.subscription_id, 0) AND earlier.id < o.id AND earlier.sent_at IS NULL AND earlier.cancelled = 0) ORDER BY o.id LIMIT 30').all(now) as unknown as Outbox[]; }
  sent(id: number, now: number): void { this.db.prepare('UPDATE outbox SET sent_at = ? WHERE id = ?').run(now, id); }
  cancel(id: number): void { this.db.prepare('UPDATE outbox SET cancelled = 1 WHERE id = ?').run(id); }
  defer(id: number, until: number): void { this.db.prepare('UPDATE outbox SET available_at = ? WHERE id = ?').run(until, id); }
  retry(id: number, now: number, seconds?: number): void {
    const row = this.db.prepare('SELECT attempts FROM outbox WHERE id = ?').get(id) as { attempts: number };
    const wait = Math.max(seconds ?? 0, Math.min(3600, 5 * 2 ** Math.min(row.attempts, 10)));
    this.db.prepare('UPDATE outbox SET attempts = attempts + 1, available_at = ? WHERE id = ?').run(now + wait * 1000, id);
  }
  getShipment(id: number): Shipment { return this.db.prepare('SELECT * FROM shipments WHERE id = ?').get(id) as unknown as Shipment; }
  ensureShipment(carrier: string, number: string): Shipment {
    this.db.prepare('INSERT OR IGNORE INTO shipments(carrier, number) VALUES (?, ?)').run(carrier, number);
    return this.db.prepare('SELECT * FROM shipments WHERE carrier = ? AND number = ?').get(carrier, number) as unknown as Shipment;
  }
  private subscriptionQuery = `SELECT s.*, p.carrier, p.number, p.snapshot, p.checked_at, p.last_error FROM subscriptions s JOIN shipments p ON p.id = s.shipment_id`;
  subscriptions(userId: number, all = true): Subscription[] {
    return this.db.prepare(`${this.subscriptionQuery} WHERE s.user_id = ? ${all ? '' : "AND s.mode = 'active'"} ORDER BY s.id`).all(userId) as unknown as Subscription[];
  }
  subscription(userId: number, id: number): Subscription {
    const found = this.db.prepare(`${this.subscriptionQuery} WHERE s.user_id = ? AND s.id = ?`).get(userId, id) as unknown as Subscription | undefined;
    if (!found) throw new SafeError('내 목록에 없는 택배입니다. /list all로 확인해주세요.');
    return found;
  }
  add(userId: number, shipmentId: number, alias: string): { subscription: Subscription; created: boolean } {
    const result = this.db.prepare('INSERT OR IGNORE INTO subscriptions(user_id, shipment_id, alias) VALUES (?, ?, ?)').run(userId, shipmentId, alias.slice(0, 100));
    const sub = this.db.prepare(`${this.subscriptionQuery} WHERE s.user_id = ? AND s.shipment_id = ?`).get(userId, shipmentId) as unknown as Subscription;
    // Historical events belong to the registration baseline, not new-change notifications.
    if (result.changes && sub.snapshot) this.initializeSubscription(sub, JSON.parse(sub.snapshot) as TrackingResult);
    return { subscription: this.subscription(userId, sub.id), created: result.changes > 0 };
  }
  private state(result: TrackingResult): string { return JSON.stringify([result.found, result.status, result.label]); }
  private markSeen(sub: Subscription, events: DeliveryEvent[]): void {
    const insert = this.db.prepare('INSERT OR IGNORE INTO seen VALUES (?, ?)');
    for (const event of events) insert.run(sub.id, event.key);
  }
  private initializeSubscription(sub: Subscription, result: TrackingResult): void {
    this.markSeen(sub, this.events(sub.shipment_id));
    this.db.prepare('UPDATE subscriptions SET initialized = 1, last_state = ?, mode = ? WHERE id = ?').run(this.state(result), result.status === 'delivered' ? 'done' : sub.mode, sub.id);
  }
  rename(userId: number, id: number, alias: string): void {
    this.subscription(userId, id);
    if (!alias.trim() || alias.length > 100) throw new SafeError('별명은 1~100자로 입력해주세요.');
    this.db.prepare('UPDATE subscriptions SET alias = ? WHERE id = ?').run(alias.trim(), id);
  }
  mode(userId: number, id: number, mode: 'active' | 'paused'): void {
    const sub = this.subscription(userId, id);
    if (mode === 'active' && sub.mode === 'done') throw new SafeError('이미 배송 완료된 택배입니다. /track으로 다시 조회할 수 있습니다.');
    if (sub.mode === 'done') throw new SafeError('배송 완료로 자동 조회가 종료된 택배입니다.');
    this.db.prepare('UPDATE subscriptions SET mode = ? WHERE id = ?').run(mode, id);
    if (mode === 'active') {
      this.db.prepare('UPDATE shipments SET next_check = 0 WHERE id = ?').run(sub.shipment_id);
      this.db.prepare("UPDATE outbox SET available_at = 0 WHERE subscription_id = ? AND kind = 'delivery' AND sent_at IS NULL AND cancelled = 0").run(sub.id);
    }
  }
  remove(userId: number, id: number): void {
    const sub = this.subscription(userId, id);
    this.db.prepare('DELETE FROM subscriptions WHERE id = ?').run(sub.id);
    this.db.prepare('DELETE FROM shipments WHERE id = ? AND NOT EXISTS (SELECT 1 FROM subscriptions WHERE shipment_id = ?)').run(sub.shipment_id, sub.shipment_id);
  }
  events(shipmentId: number): DeliveryEvent[] {
    return (this.db.prepare('SELECT payload FROM events WHERE shipment_id = ?').all(shipmentId) as { payload: string }[])
      .map(row => JSON.parse(row.payload) as DeliveryEvent).sort((a, b) => (a.time ? Date.parse(a.time) : 0) - (b.time ? Date.parse(b.time) : 0) || a.key.localeCompare(b.key));
  }
  due(now: number): Shipment[] {
    return this.db.prepare(`SELECT p.* FROM shipments p WHERE p.next_check <= ? AND EXISTS (
      SELECT 1 FROM subscriptions s JOIN users u ON u.id = s.user_id WHERE s.shipment_id = p.id AND s.mode = 'active' AND u.status = 'approved'
    ) ORDER BY p.next_check, p.id`).all(now) as unknown as Shipment[];
  }
  active(shipmentId: number): Subscription[] {
    return this.db.prepare(`${this.subscriptionQuery} JOIN users u ON u.id = s.user_id WHERE s.shipment_id = ? AND s.mode = 'active' AND u.status = 'approved'`).all(shipmentId) as unknown as Subscription[];
  }
  apply(shipmentId: number, result: TrackingResult, now: number, interval: number): void {
    this.transaction(() => {
      const old = this.getShipment(shipmentId);
      if (!old) return; // A registration may have been deleted while a request was in flight.
      const revision = old.revision + 1;
      this.db.prepare('UPDATE shipments SET snapshot = ?, checked_at = ?, next_check = ?, failures = 0, last_error = NULL, revision = ? WHERE id = ?')
        .run(JSON.stringify(result), now, now + interval, revision, shipmentId);
      const insert = this.db.prepare('INSERT OR IGNORE INTO events VALUES (?, ?, ?)');
      for (const event of result.events) insert.run(shipmentId, event.key, JSON.stringify(event));
      for (const sub of this.active(shipmentId)) {
        if (sub.error_notified) {
          this.queue(`recovered:${sub.id}:${revision}`, sub.user_id, { text: `${title(sub)}\n배송조회가 복구되었습니다.` }, 'delivery', sub.id);
          this.db.prepare('UPDATE subscriptions SET error_notified = 0 WHERE id = ?').run(sub.id);
        }
        if (!sub.initialized) {
          this.queue(`initial:${sub.id}`, sub.user_id, { text: summary(sub, result) }, 'delivery', sub.id);
          this.initializeSubscription(sub, result);
          continue;
        }
        const unseen = this.events(shipmentId).filter(event => !this.db.prepare('SELECT 1 FROM seen WHERE subscription_id = ? AND event_key = ?').get(sub.id, event.key));
        if (unseen.length || sub.last_state !== this.state(result)) {
          this.queue(`change:${sub.id}:${revision}`, sub.user_id, { text: `${title(sub)}\n📦 ${result.label}\n\n${unseen.map(eventLine).join('\n\n')}${result.status === 'delivered' ? '\n\n배송 완료로 자동 조회를 종료합니다.' : ''}` }, 'delivery', sub.id);
          this.markSeen(sub, unseen);
        }
        this.db.prepare('UPDATE subscriptions SET last_state = ?, mode = ? WHERE id = ?').run(this.state(result), result.status === 'delivered' ? 'done' : 'active', sub.id);
      }
    });
  }
  fail(shipmentId: number, error: string, now: number, retrySeconds?: number): void {
    this.transaction(() => {
      const old = this.getShipment(shipmentId);
      if (!old) return;
      const failures = old.failures + 1;
      const wait = Math.max((retrySeconds ?? 0) * 1000, Math.min(3_600_000, 60_000 * 2 ** Math.min(failures - 1, 6)));
      this.db.prepare('UPDATE shipments SET failures = ?, last_error = ?, next_check = ? WHERE id = ?').run(failures, error, now + wait, shipmentId);
      if (failures >= 3) for (const sub of this.active(shipmentId)) {
        if (sub.error_notified) continue;
        this.queue(`error:${sub.id}:${old.revision}`, sub.user_id, { text: `${title(sub)}\n배송조회가 연속 실패했습니다. ${error}\n자동으로 재시도합니다.` }, 'delivery', sub.id);
        this.db.prepare('UPDATE subscriptions SET error_notified = 1 WHERE id = ?').run(sub.id);
      }
    });
  }
  conversation(userId: number): Conversation | undefined {
    const row = this.db.prepare('SELECT payload FROM conversations WHERE user_id = ?').get(userId) as { payload: string } | undefined;
    if (!row) return undefined;
    const value = JSON.parse(row.payload) as Conversation;
    if (value.expires < Date.now()) { this.clearConversation(userId); return undefined; }
    return value;
  }
  setConversation(userId: number, value: Conversation): void { this.db.prepare('INSERT INTO conversations VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET payload = excluded.payload').run(userId, JSON.stringify(value)); }
  clearConversation(userId: number): void { this.db.prepare('DELETE FROM conversations WHERE user_id = ?').run(userId); }
}
export function title(sub: Pick<Subscription, 'id' | 'alias' | 'number' | 'carrier'>): string { return `#${sub.id} ${sub.alias || '택배'} · ${carrierNames.get(sub.carrier) ?? sub.carrier}\n${sub.number}`; }
export function summary(sub: Subscription, result?: TrackingResult): string {
  const snapshot = result ?? (sub.snapshot ? JSON.parse(sub.snapshot) as TrackingResult : undefined);
  const latest = snapshot?.events.at(-1);
  return `${title(sub)}\n${snapshot?.label ?? '조회 대기'}${latest ? `\n${eventLine(latest)}` : ''}\n최근 성공 조회: ${formatTime(sub.checked_at)}${snapshot?.status === 'delivered' ? '\n배송 완료로 자동 조회를 종료합니다.' : ''}${sub.last_error ? `\n최근 오류: ${sub.last_error}` : ''}`;
}
export function splitText(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf('\n', limit);
    if (cut < limit / 2) cut = limit;
    if (/[\uD800-\uDBFF]/.test(remaining[cut - 1]!)) cut--;
    chunks.push(remaining.slice(0, cut)); remaining = remaining.slice(cut).replace(/^\n/, '');
  }
  if (remaining || !chunks.length) chunks.push(remaining);
  return chunks;
}
