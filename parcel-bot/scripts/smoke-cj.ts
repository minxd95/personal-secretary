import { CjCarrier } from '../src/carriers/cj.ts';
import { formatTime, safeError } from '../src/domain.ts';
const number = process.argv[2];
if (!number) { console.error('사용법: npm run smoke:cj -- 운송장번호'); process.exitCode = 1; }
else {
  try {
    const result = await new CjCarrier().track(number);
    // Do not print the tracking number, recipient data or driver details to console logs.
    console.log({ found: result.found, status: result.status, eventCount: result.events.length, latestTime: result.events.at(-1) ? formatTime(result.events.at(-1)!.time) : null });
  } catch (error) { console.error(safeError(error)); process.exitCode = 1; }
}
