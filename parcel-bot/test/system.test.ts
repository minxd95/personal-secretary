import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bot } from '../src/bot.ts';
import { CjCarrier, parseCjResponse } from '../src/carriers/cj.ts';
import { type Carrier, SafeError } from '../src/domain.ts';
import { TrackingService } from '../src/service.ts';
import { Store, type Message } from '../src/store.ts';
import { Dispatcher, TelegramError, type Update } from '../src/telegram.ts';

const snapshot = (codes: string[]) => parseCjResponse({ parcelResultMap: { resultList: [{}] }, parcelDetailResultMap: { resultList: codes.map((code, i) => ({ crgSt: code, dTime: `2026-10-02 ${String(10 + i).padStart(2, '0')}:00:00`, crgNm: `단계 ${code}`, regBranNm: '터미널' })) } });
function harness(path = ':memory:') {
  const store = new Store(path);
  let now = 1_800_000_000_000, calls = 0;
  let value = snapshot(['11']);
  let failure = false;
  const cj = new CjCarrier();
  const carrier: Carrier = { id: 'cj', name: cj.name, aliases: cj.aliases, normalize: number => cj.normalize(number), track: async () => { calls++; if (failure) throw new SafeError('연결 실패'); return value; } };
  const service = new TrackingService(store, [carrier], 900_000, () => now);
  const bot = new Bot(store, service, 1);
  let updateId = Number(store.meta('telegram_offset') ?? '0');
  const update = (user: number, text: string): Update => ({ update_id: updateId++, message: { message_id: updateId, chat: { id: user, type: 'private' }, from: { id: user, first_name: `사용자${user}` }, text } });
  const command = (user: number, text: string) => { const item = update(user, text); bot.handle(item); return item; };
  const callback = (user: number, data: string) => bot.handle({ update_id: updateId++, callback_query: { id: String(updateId), from: { id: user, first_name: '버튼사용자' }, data, message: { message_id: 1, chat: { id: user, type: 'private' } } } });
  const messages = (user?: number) => (store.db.prepare(`SELECT * FROM outbox ${user ? 'WHERE user_id = ?' : ''} ORDER BY id`).all(...(user ? [user] : [])) as { payload: string; kind: string; cancelled: number; sent_at: number | null }[]).map(row => ({ ...row, message: JSON.parse(row.payload) as Message }));
  return { store, bot, service, command, callback, update, messages, now: () => now, advance: (ms = 900_001) => { now += ms; }, setValue: (codes: string[]) => { value = snapshot(codes); }, setFailure: (v: boolean) => { failure = v; }, calls: () => calls };
}

test('approval requests deduplicate, admin only, private chats only, block cancels delivery', async () => {
  const h = harness();
  try {
    h.command(2, '/start'); h.command(2, '/start');
    assert.equal(h.messages(1).filter(row => row.message.text.includes('사용 신청:')).length, 1);
    h.command(2, '/add cj 123456789012'); assert.equal(h.store.subscriptions(2).length, 0);
    h.command(1, '/approve 2'); assert.equal(h.store.user(2)?.status, 'approved');
    h.command(2, '/approve 3'); assert.match(h.messages(2).at(-1)!.message.text, /관리자 전용/);
    h.command(2, '/add cj 123456789012 신발'); await h.bot.jobs();
    h.command(1, '/block 2'); assert.equal(h.store.user(2)?.status, 'blocked');
    const sent: string[] = [];
    await new Dispatcher(h.store, { send: async (_, message) => { sent.push(message.text); } }, h.now).tick();
    assert.ok(!sent.some(text => text.includes('신발')));
    const group = h.update(3, '/start'); group.message!.chat.type = 'group'; group.message!.chat.id = -100;
    h.bot.handle(group); assert.equal(h.store.user(3), undefined);
  } finally { h.store.close(); }
});
test('duplicate updates and registrations are idempotent; cross-user commands/buttons fail', async () => {
  const h = harness();
  try {
    h.command(2, '/start'); h.command(1, '/approve 2');
    const first = h.command(1, '/add cj 123456789012 운동화');
    h.bot.handle(first); h.command(1, '/add 대한통운 1234-5678-9012 중복');
    assert.equal(h.store.subscriptions(1).length, 1);
    const sub = h.store.subscriptions(1)[0]!;
    for (const command of ['track', 'history', 'rename', 'pause', 'resume', 'remove']) h.command(2, `/${command} ${sub.id} 침입`);
    h.callback(2, `confirmremove:${sub.id}`);
    assert.equal(h.store.subscription(1, sub.id).alias, '운동화');
    assert.equal(h.store.subscription(1, sub.id).mode, 'active');
    assert.ok(h.messages(2).filter(row => row.message.text.includes('내 목록에 없는')).length >= 7);
    h.command(1, `/remove ${sub.id}`); assert.equal(h.store.subscriptions(1).length, 1);
    h.callback(1, `confirmremove:${sub.id}`); assert.equal(h.store.subscriptions(1).length, 0);
  } finally { h.store.close(); }
});
test('wizard survives replay, accepts spaced numbers, supports aliases and cancel', () => {
  const h = harness();
  try {
    h.command(1, '/add'); h.callback(1, 'carrier:cj');
    const number = h.command(1, '1234 5678 9012'); h.bot.handle(number);
    assert.equal(h.store.conversation(1)?.step, 'alias');
    h.command(1, '책'); assert.equal(h.store.subscriptions(1)[0]?.alias, '책');
    h.command(1, '/rename 1'); h.command(1, '새 책'); assert.equal(h.store.subscriptions(1)[0]?.alias, '새 책');
    h.command(1, '/add'); h.command(1, '/cancel'); assert.equal(h.store.conversation(1), undefined);
  } finally { h.store.close(); }
});
test('shared tracking, caching, new-event grouping, stable dedupe, completion', async () => {
  const h = harness();
  try {
    h.command(2, '/start'); h.command(1, '/approve 2');
    h.command(1, '/add cj 123456789012 내택배'); h.command(2, '/add cj 123456789012 다른별명');
    await h.bot.jobs(); assert.equal(h.calls(), 1);
    assert.equal(h.store.subscriptions(1)[0]!.shipment_id, h.store.subscriptions(2)[0]!.shipment_id);
    const initial = h.messages().filter(row => row.kind === 'delivery').length;
    h.advance(); await h.service.poll(); assert.equal(h.messages().filter(row => row.kind === 'delivery').length, initial);
    h.setValue(['11', '41', '82']); h.advance(); await h.service.poll();
    assert.equal(h.messages().filter(row => row.kind === 'delivery').length, initial + 2);
    assert.match(h.messages(1).at(-1)!.message.text, /단계 41[\s\S]*단계 82/);
    h.setValue(['11', '41', '82', '91']); h.advance(); await h.service.poll();
    assert.equal(h.store.subscriptions(1)[0]!.mode, 'done');
    assert.equal(h.store.due(h.now() + 900_000).length, 0);
    assert.match(h.messages(2).at(-1)!.message.text, /배송 완료로/);
  } finally { h.store.close(); }
});
test('paused user does not receive new events, resume catches up without affecting other user', async () => {
  const h = harness();
  try {
    h.command(2, '/start'); h.command(1, '/approve 2'); h.command(1, '/add cj 123456789012'); h.command(2, '/add cj 123456789012'); await h.bot.jobs();
    const sub = h.store.subscriptions(1)[0]!; h.command(1, `/pause ${sub.id}`);
    const before = h.messages(1).filter(row => row.kind === 'delivery').length;
    h.advance(); h.setValue(['11', '41']); await h.service.poll();
    assert.equal(h.messages(1).filter(row => row.kind === 'delivery').length, before);
    h.command(1, `/resume ${sub.id}`); h.advance(60_001); await h.service.poll();
    assert.equal(h.messages(1).filter(row => row.kind === 'delivery').length, before + 1);
  } finally { h.store.close(); }
});
test('three failures alert once, retry backoff applies, recovery alerts once', async () => {
  const h = harness();
  try {
    h.command(1, '/add cj 123456789012'); await h.bot.jobs(); h.setFailure(true);
    for (let i = 0; i < 4; i++) { h.advance(3_600_001); await h.service.poll(); }
    assert.equal(h.messages(1).filter(row => row.message.text.includes('연속 실패')).length, 1);
    const shipment = h.store.getShipment(h.store.subscriptions(1)[0]!.shipment_id);
    assert.equal(shipment.failures, 4); assert.ok(shipment.next_check > h.now());
    h.setFailure(false); h.advance(3_600_001); await h.service.poll();
    assert.equal(h.messages(1).filter(row => row.message.text.includes('복구되었습니다')).length, 1);
    h.advance(); await h.service.poll(); assert.equal(h.messages(1).filter(row => row.message.text.includes('복구되었습니다')).length, 1);
  } finally { h.store.close(); }
});
test('manual and scheduled checks coalesce and reuse a 60-second cache', async () => {
  const h = harness();
  try {
    h.command(1, '/add cj 123456789012');
    const id = h.store.subscriptions(1)[0]!.shipment_id;
    await Promise.all([h.service.refresh(id), h.service.refresh(id), h.service.poll()]);
    assert.equal(h.calls(), 1);
    await h.service.refresh(id); assert.equal(h.calls(), 1);
    h.advance(60_001); await h.service.refresh(id); assert.equal(h.calls(), 2);
  } finally { h.store.close(); }
});
test('transaction rollback leaves neither snapshot nor notification partially committed', () => {
  const h = harness();
  try {
    h.command(1, '/add cj 123456789012'); const sub = h.store.subscriptions(1)[0]!;
    h.store.db.exec("CREATE TRIGGER reject_delivery BEFORE INSERT ON outbox WHEN NEW.kind = 'delivery' BEGIN SELECT RAISE(ABORT, 'disk failure simulation'); END");
    assert.throws(() => h.store.apply(sub.shipment_id, snapshot(['11']), h.now(), 900_000));
    assert.equal(h.store.getShipment(sub.shipment_id).snapshot, null);
    assert.equal(h.store.events(sub.shipment_id).length, 0);
    assert.equal(h.store.subscription(1, sub.id).initialized, 0);
  } finally { h.store.close(); }
});
test('outbox, jobs, command offset and subscriptions survive restart; sending retries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'parcel-test-')); const path = join(dir, 'db.sqlite');
  let h = harness(path);
  try {
    const add = h.command(1, '/add cj 123456789012');
    const offset = h.store.meta('telegram_offset'); h.store.close(); h = harness(path);
    assert.equal(h.store.meta('telegram_offset'), offset); h.bot.handle(add);
    assert.equal(h.store.subscriptions(1).length, 1); await h.bot.jobs();
    let failures = true; const sent: string[] = [];
    const dispatcher = new Dispatcher(h.store, { send: async (_, message) => { if (failures) throw new SafeError('offline'); sent.push(message.text); } }, h.now);
    await dispatcher.tick(); assert.equal(sent.length, 0);
    failures = false; h.advance(60_000); await dispatcher.tick();
    assert.ok(sent.some(text => text.includes('123456789012')));
    const count = sent.length; await dispatcher.tick(); assert.equal(sent.length, count);
  } finally { h.store.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('Telegram 429 delays sending globally, 403 is not retried indefinitely', async () => {
  const h = harness();
  try {
    h.command(1, '/help'); let calls = 0;
    const dispatcher = new Dispatcher(h.store, { send: async () => { calls++; throw new TelegramError(calls === 1 ? 429 : 403, 30); } }, h.now);
    await dispatcher.tick(); await dispatcher.tick(); assert.equal(calls, 1);
    h.advance(31_000); await dispatcher.tick(); assert.equal(calls, 2);
    h.command(1, '/help'); await dispatcher.tick(); assert.equal(calls, 3); // a new incoming command clears unreachable state
    await dispatcher.tick(); assert.equal(calls, 3);
  } finally { h.store.close(); }
});
test('setup mode exposes only the caller ID, never grants first-user administrator', () => {
  const store = new Store(':memory:');
  try {
    const bot = new Bot(store, new TrackingService(store, [new CjCarrier()]));
    bot.handle({ update_id: 0, message: { message_id: 1, chat: { id: 7, type: 'private' }, from: { id: 7, first_name: 'x' }, text: '/whoami' } });
    assert.equal(store.user(7)?.status, 'pending');
    assert.match(store.pending(Date.now())[0]!.payload, /7/);
  } finally { store.close(); }
});

test('not-found registrations remain active and first real tracking data generates one update', async () => {
  const h = harness();
  try {
    const pending = parseCjResponse({ parcelResultMap: { resultList: [] }, parcelDetailResultMap: { resultList: [] } });
    h.command(1, '/add cj 123456789012');
    const sub = h.store.subscriptions(1)[0]!;
    h.store.apply(sub.shipment_id, pending, h.now(), 900_000);
    assert.equal(h.store.subscription(1, sub.id).mode, 'active');
    const before = h.messages(1).filter(row => row.kind === 'delivery').length;
    h.advance(); await h.service.poll();
    assert.equal(h.messages(1).filter(row => row.kind === 'delivery').length, before + 1);
    assert.match(h.messages(1).at(-1)!.message.text, /상품인수/);
  } finally { h.store.close(); }
});
test('pausing defers queued delivery, allows commands, and resuming releases it immediately', async () => {
  const h = harness();
  try {
    h.command(1, '/add cj 123456789012'); await h.bot.jobs();
    const sub = h.store.subscriptions(1)[0]!;
    h.command(1, `/pause ${sub.id}`);
    const sent: string[] = []; const dispatcher = new Dispatcher(h.store, { send: async (_, msg) => { sent.push(msg.text); } }, h.now);
    await dispatcher.tick(); await dispatcher.tick();
    assert.ok(sent.some(text => text.includes('일시중지')));
    assert.ok(!sent.some(text => text.includes('단계 11')));
    h.command(1, `/resume ${sub.id}`); await dispatcher.tick();
    assert.ok(sent.some(text => text.includes('단계 11')));
  } finally { h.store.close(); }
});
test('a failed first message chunk cannot be overtaken by later chunks', async () => {
  const h = harness();
  try {
    h.store.queue('long', 1, { text: 'A'.repeat(3500) + 'B'.repeat(100) });
    let fail = true; const sent: string[] = [];
    const dispatcher = new Dispatcher(h.store, { send: async (_, msg) => { if (fail) throw new SafeError('offline'); sent.push(msg.text); } }, h.now);
    await dispatcher.tick(); fail = false; await dispatcher.tick(); assert.equal(sent.length, 0);
    h.advance(60_000); await dispatcher.tick(); await dispatcher.tick();
    assert.deepEqual(sent, ['A'.repeat(3500), 'B'.repeat(100)]);
  } finally { h.store.close(); }
});
test('removal during an in-flight request cannot recreate a deleted shipment or notifications', async () => {
  const h = harness();
  try {
    h.command(1, '/add cj 123456789012'); const sub = h.store.subscriptions(1)[0]!;
    const request = h.service.refresh(sub.shipment_id);
    h.callback(1, `confirmremove:${sub.id}`);
    await request;
    assert.equal(h.store.getShipment(sub.shipment_id), undefined);
    assert.equal(h.store.db.prepare('SELECT count(*) AS n FROM events').get()!.n, 0);
    assert.equal(h.messages(1).filter(row => row.kind === 'delivery').length, 0);
  } finally { h.store.close(); }
});
