import { copyFileSync, chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Node.js 24에서 실행해주세요.');
for (const name of ['data', 'logs']) mkdirSync(root + name, { recursive: true, mode: 0o700 });
if (!existsSync(root + '.env')) copyFileSync(root + '.env.example', root + '.env');
chmodSync(root + '.env', 0o600);
writeFileSync(root + '.node-path', realpathSync(process.execPath) + '\n');
console.log('로컬 .env와 Node 24 실행 경로를 준비했습니다. .env에 봇 토큰과 관리자 ID를 입력해주세요.');
