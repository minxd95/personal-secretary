import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { SafeError } from './domain.ts';
export function acquireLock(path: string): () => void {
  try {
    const fd = openSync(path, 'wx', 0o600);
    writeFileSync(fd, String(process.pid)); closeSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const pid = Number(readFileSync(path, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new SafeError('프로세스 잠금 파일을 확인해주세요. 다른 인스턴스가 시작 중일 수 있습니다.');
    try { process.kill(pid, 0); }
    catch (probe) {
      if ((probe as NodeJS.ErrnoException).code === 'ESRCH') { unlinkSync(path); return acquireLock(path); }
    }
    throw new SafeError('같은 DB를 사용하는 봇이 이미 실행 중입니다. PM2와 npm start를 동시에 실행하지 마세요.');
  }
  return () => { if (existsSync(path) && readFileSync(path, 'utf8') === String(process.pid)) unlinkSync(path); };
}
