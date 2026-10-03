import test from 'node:test';
import assert from 'node:assert/strict';
import { CjCarrier, parseCjResponse } from '../src/carriers/cj.ts';

const row = (code = '11', time = '2026-10-02 10:00:00') => ({ crgSt: code, dTime: time, crgNm: '상품을 인수했습니다.', regBranNm: '서울', scanNm: '처리' });
const payload = (rows: unknown[], parcels: unknown[] = []) => ({ parcelResultMap: { resultList: parcels }, parcelDetailResultMap: { resultList: rows } });

test('CJ numbers normalize spaces/hyphens, rejecting letters and wrong lengths', () => {
  const cj = new CjCarrier();
  assert.equal(cj.normalize('1234 - 5678 - 9012'), '123456789012');
  assert.equal(cj.normalize('1234567890'), '1234567890');
  for (const invalid of ['123', '12345678901', 'abcdefghijkl', '1e123456789']) assert.throws(() => cj.normalize(invalid));
});
test('empty results are pending, malformed results are errors', () => {
  assert.equal(parseCjResponse(payload([])).found, false);
  assert.equal(parseCjResponse(payload([], [{}])).found, true);
  for (const bad of [{}, null, { parcelResultMap: { resultList: [] } }, payload([{}])]) assert.throws(() => parseCjResponse(bad));
});
test('sort/deduplicate events, preserve unknown codes, identify completion', () => {
  const data = [row('91', '2026-10-02 18:00:00'), row(), row('11'), row('NEW', '2026-10-02 11:00:00')];
  const parsed = parseCjResponse(payload(data));
  assert.equal(parsed.status, 'delivered');
  assert.equal(parsed.events.length, 3);
  assert.equal(parsed.events[1]?.status, 'unknown');
  assert.equal(parsed.events[0]?.time, '2026-10-02T10:00:00+09:00');
  assert.deepEqual(parsed, parseCjResponse(payload(data.reverse())));
});
test('all documented CJ status codes are normalized', () => {
  for (const [code, expected] of Object.entries({ '11': 'accepted', '41': 'in_transit', '21': 'in_transit', '44': 'in_transit', RMN: 'in_transit', '42': 'at_destination', '82': 'out_for_delivery', '91': 'delivered' })) {
    assert.equal(parseCjResponse(payload([row(code)])).status, expected);
  }
});
test('CJ session cookies and CSRF are used, 403 renews session only once', async () => {
  let pageCalls = 0, detailCalls = 0;
  const fake: typeof fetch = async (input, init) => {
    if (String(input).endsWith('tracking')) {
      pageCalls++;
      return new Response(`var GLOBAL_CSRF_NAME = "_csrf"; var GLOBAL_CSRF_VALUE = "token${pageCalls}";`, { headers: { 'set-cookie': `JSESSIONID=s${pageCalls}; Path=/` } });
    }
    detailCalls++;
    assert.equal(new Headers(init?.headers).get('cookie'), `JSESSIONID=s${pageCalls}`);
    assert.equal((init?.body as URLSearchParams).get('_csrf'), `token${pageCalls}`);
    if (detailCalls === 1) return new Response('', { status: 403 });
    return Response.json(payload([row()]));
  };
  assert.equal((await new CjCarrier(0, 1000, fake).track('123456789012')).status, 'accepted');
  assert.equal(pageCalls, 2); assert.equal(detailCalls, 2);
});
test('rate limits retain retry delay and network errors do not become not-found', async () => {
  const fake: typeof fetch = async (input) => String(input).endsWith('tracking')
    ? new Response('var GLOBAL_CSRF_NAME="_csrf";var GLOBAL_CSRF_VALUE="x";')
    : new Response('', { status: 429, headers: { 'retry-after': '120' } });
  await assert.rejects(new CjCarrier(0, 1000, fake).track('123456789012'), { retryAfterSeconds: 120 });
  await assert.rejects(new CjCarrier(0, 1000, async () => { throw new Error('secret'); }).track('123456789012'), /연결하지 못했습니다/);
});
