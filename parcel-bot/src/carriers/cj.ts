import { SafeError, delay, eventKey, plain, type Carrier, type DeliveryEvent, type DeliveryStatus, type TrackingResult } from '../domain.ts';

const BASE = 'https://www.cjlogistics.com';
const PAGE = `${BASE}/ko/tool/parcel/tracking`;
const statuses: Record<string, [DeliveryStatus, string]> = {
  '11': ['accepted', '상품인수'], '41': ['in_transit', '상품이동중'],
  '21': ['in_transit', '상품이동중'], '44': ['in_transit', '상품이동중'],
  RMN: ['in_transit', 'HUB 도착'], '42': ['at_destination', '배송지도착'],
  '82': ['out_for_delivery', '배송출발'], '91': ['delivered', '배송완료'],
};
function retryAfter(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value) return undefined;
  const seconds = /^\d+$/.test(value) ? Number(value) : Math.ceil((Date.parse(value) - Date.now()) / 1000);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SafeError('CJ 조회 응답 형식이 변경되었습니다.');
  return value as Record<string, unknown>;
}
function list(value: unknown): unknown[] {
  const result = object(value).resultList;
  if (!Array.isArray(result)) throw new SafeError('CJ 조회 응답 형식이 변경되었습니다.');
  return result;
}
function requiredString(value: unknown): string {
  if (typeof value !== 'string') throw new SafeError('CJ 배송 이벤트 형식을 확인할 수 없습니다.');
  return plain(value);
}
function parseTime(value: string): string | null {
  if (!value) return null;
  const match = /^(\d{4})[.-](\d{2})[.-](\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) throw new SafeError('CJ 배송 처리 시각 형식을 확인할 수 없습니다.');
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] ?? '00'}+09:00`;
  if (!Number.isFinite(Date.parse(iso))) throw new SafeError('CJ 배송 처리 시각이 올바르지 않습니다.');
  return iso;
}
export function parseCjResponse(raw: unknown): TrackingResult {
  const root = object(raw);
  const parcels = list(root.parcelResultMap);
  const rows = list(root.parcelDetailResultMap);
  const events = rows.map((row): DeliveryEvent => {
    const item = object(row);
    const code = requiredString(item.crgSt);
    const rawTime = requiredString(item.dTime);
    const description = requiredString(item.crgNm);
    const location = requiredString(item.regBranNm);
    const [status, label] = statuses[code] ?? ['unknown', typeof item.scanNm === 'string' ? plain(item.scanNm) || '상태 확인 중' : '상태 확인 중'];
    return { key: eventKey([rawTime, code, location, description]), time: parseTime(rawTime), status, code, label, description, location };
  });
  // Deterministic ordering prevents source row reordering from generating false changes.
  const unique = [...new Map(events.map(event => [event.key, event])).values()].sort((a, b) =>
    (a.time ? Date.parse(a.time) : 0) - (b.time ? Date.parse(b.time) : 0) || a.key.localeCompare(b.key));
  const latestTime = unique.at(-1)?.time;
  const last = unique.findLast(event => event.status === 'delivered' && event.time === latestTime) ?? unique.at(-1);
  return { status: last?.status ?? 'pending', label: last?.label ?? '상품준비 / 배송정보 대기', events: unique, found: parcels.length > 0 || unique.length > 0 };
}

export class CjCarrier implements Carrier {
  id = 'cj'; name = 'CJ대한통운'; aliases = ['cj', 'cj대한통운', '대한통운'];
  private cookies = new Map<string, string>();
  private csrf?: { name: string; value: string };
  private tail: Promise<unknown> = Promise.resolve();
  private lastRequest = 0;
  constructor(private readonly gapMs = 2000, private readonly timeoutMs = 15000, private readonly fetcher: typeof fetch = fetch) {}
  normalize(number: string): string {
    const clean = number.replace(/[\s-]/g, '');
    if (!/^(?:\d{10}|\d{12})$/.test(clean)) throw new SafeError('CJ 운송장번호는 숫자 10자리 또는 12자리여야 합니다.');
    return clean;
  }
  track(number: string): Promise<TrackingResult> {
    const normalized = this.normalize(number);
    const task = this.tail.then(() => this.query(normalized));
    this.tail = task.catch(() => undefined);
    return task;
  }
  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    await delay(Math.max(0, this.lastRequest + this.gapMs - Date.now()));
    this.lastRequest = Date.now();
    let response: Response;
    try {
      response = await this.fetcher(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs), headers: {
        'User-Agent': 'Mozilla/5.0', Referer: PAGE,
        Cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '), ...init.headers,
      } });
    } catch { throw new SafeError('CJ 조회 서버에 연결하지 못했습니다.'); }
    for (const header of response.headers.getSetCookie()) {
      const entry = header.split(';')[0]!;
      const i = entry.indexOf('=');
      if (i > 0) this.cookies.set(entry.slice(0, i), entry.slice(i + 1));
    }
    return response;
  }
  private async session(): Promise<void> {
    const response = await this.request(PAGE);
    if (!response.ok) throw new SafeError(`CJ 조회 페이지 연결 실패 (HTTP ${response.status}).`, retryAfter(response));
    let html: string;
    try { html = await response.text(); } catch { throw new SafeError('CJ 조회 페이지 읽기에 실패했습니다.'); }
    const name = /var\s+GLOBAL_CSRF_NAME\s*=\s*["']([^"']+)["']/.exec(html)?.[1];
    const value = /var\s+GLOBAL_CSRF_VALUE\s*=\s*["']([^"']+)["']/.exec(html)?.[1];
    if (!name || !value) throw new SafeError('CJ 조회 페이지의 세션 정보를 찾을 수 없습니다.');
    this.csrf = { name, value };
  }
  private async query(number: string): Promise<TrackingResult> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.csrf) await this.session();
      const response = await this.request(`${BASE}/ko/tool/parcel/tracking-detail`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
        body: new URLSearchParams({ [this.csrf!.name]: this.csrf!.value, paramInvcNo: number }),
      });
      if ((response.status === 403 || response.status === 401) && attempt === 0) { this.csrf = undefined; continue; }
      if (!response.ok) {
        throw new SafeError(`CJ 조회 실패 (HTTP ${response.status}).`, retryAfter(response));
      }
      if (!(response.headers.get('content-type') ?? '').includes('json')) {
        if (attempt === 0) { this.csrf = undefined; continue; }
        throw new SafeError('CJ 조회 응답 형식이 변경되었습니다.');
      }
      let json: unknown;
      try { json = await response.json(); } catch { throw new SafeError('CJ 조회 응답을 읽을 수 없습니다.'); }
      return parseCjResponse(json);
    }
    throw new SafeError('CJ 조회 세션 갱신에 실패했습니다.');
  }
}
