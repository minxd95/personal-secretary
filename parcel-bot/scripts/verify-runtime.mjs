// Runs the real entrypoint under an isolated PM2 daemon with fake network I/O.
// Never uses the user's bot token or normal PM2 process list.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'parcel-runtime-'));
const cli = realpathSync(execFileSync('which', ['pm2'], { encoding: 'utf8' }).trim());
const env = { ...process.env, PM2_HOME: join(dir, 'pm2') };
const dbPath = join(dir, 'state.sqlite');
const sentPath = join(dir, 'sent.jsonl');
const bootPath = join(dir, 'boots.txt');
const mockPath = join(dir, 'network.mjs');
writeFileSync(mockPath, `
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(bootPath)}, 'boot\\n');
globalThis.fetch = async (input, init = {}) => {
 const url = String(input);
 if (url.startsWith('https://api.telegram.org/bot123:runtime-test-token/')) {
  const method = url.split('/').at(-1);
  const args = JSON.parse(init.body || '{}');
  if (method === 'getUpdates') {
   await new Promise(resolve => setTimeout(resolve, 100));
   return Response.json({ok:true,result: args.offset < 2 ? [{ update_id:1, message:{message_id:1,chat:{id:1,type:'private'},from:{id:1,first_name:'Runtime'},text:'/add cj 123456789012 테스트'} }] : []});
  }
  if (method === 'sendMessage') appendFileSync(${JSON.stringify(sentPath)}, JSON.stringify(args) + '\\n');
  return Response.json({ok:true,result:method === 'getWebhookInfo' ? {url:''} : {id:123}});
 }
 if (url === 'https://www.cjlogistics.com/ko/tool/parcel/tracking') return new Response('var GLOBAL_CSRF_NAME="_csrf"; var GLOBAL_CSRF_VALUE="test";');
 if (url === 'https://www.cjlogistics.com/ko/tool/parcel/tracking-detail') return Response.json({parcelResultMap:{resultList:[{}]},parcelDetailResultMap:{resultList:[{crgSt:'11',dTime:'2026-10-02 10:00:00',crgNm:'상품인수',regBranNm:'테스트'}]}});
 throw new Error('Unexpected network call blocked by runtime test');
};
`);
const app = { ...require(join(root, 'ecosystem.config.cjs')).apps[0], script: resolve(root, 'dist/src/main.js'),
  out_file: join(dir, 'output.log'), error_file: join(dir, 'error.log'),
  env: { NODE_ENV: 'test', TZ: 'Asia/Seoul', TELEGRAM_BOT_TOKEN: '123:runtime-test-token', ADMIN_TELEGRAM_ID: '1',
    DATABASE_PATH: dbPath, POLL_INTERVAL_MINUTES: '15', CJ_REQUEST_GAP_MS: '2000', REQUEST_TIMEOUT_MS: '15000', NODE_OPTIONS: `--import=${mockPath}` },
};
const ecosystemPath = join(dir, 'ecosystem.config.cjs');
writeFileSync(ecosystemPath, `module.exports = ${JSON.stringify({apps:[app]})};`);
const pm2 = (...args) => execFileSync(process.execPath, [cli, ...args], { env, stdio: 'pipe', timeout: 30_000 }).toString();
async function until(predicate, description) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 200)); }
  throw new Error(`Timed out: ${description}`);
}
function inspect() {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return { subscriptions: db.prepare('SELECT count(*) AS n FROM subscriptions').get().n,
    offset: db.prepare("SELECT value FROM meta WHERE key='telegram_offset'").get().value,
    pending: db.prepare('SELECT count(*) AS n FROM outbox WHERE sent_at IS NULL AND cancelled=0').get().n }; }
  finally { db.close(); }
}
try {
  pm2('start', ecosystemPath);
  await until(() => existsSync(sentPath) && readFileSync(sentPath, 'utf8').trim().split('\n').length === 2, 'initial notifications');
  assert.deepEqual(inspect(), { subscriptions: 1, offset: '2', pending: 0 });
  pm2('restart', 'parcel-bot');
  await until(() => readFileSync(bootPath, 'utf8').trim().split('\n').length === 2, 'PM2 restart');
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.deepEqual(inspect(), { subscriptions: 1, offset: '2', pending: 0 });
  assert.equal(readFileSync(sentPath, 'utf8').trim().split('\n').length, 2);
  pm2('stop', 'parcel-bot');
  assert.equal(existsSync(dbPath + '.lock'), false);
  console.log('PM2 verification passed: real entrypoint, mocked registration/notification, restart persistence, no duplicate sends, graceful shutdown.');
} catch (error) {
  if (existsSync(join(dir, 'error.log'))) console.error(readFileSync(join(dir, 'error.log'), 'utf8'));
  throw error;
} finally {
  try { pm2('kill'); } finally { rmSync(dir, { recursive: true, force: true }); }
}
