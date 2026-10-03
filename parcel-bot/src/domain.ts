import { createHash } from 'node:crypto';

export type DeliveryStatus = 'pending' | 'accepted' | 'in_transit' | 'at_destination' | 'out_for_delivery' | 'delivered' | 'unknown';
export interface DeliveryEvent {
  key: string;
  time: string | null;
  status: DeliveryStatus;
  code: string;
  label: string;
  description: string;
  location: string;
}
export interface TrackingResult {
  status: DeliveryStatus;
  label: string;
  events: DeliveryEvent[];
  found: boolean;
}
export interface Carrier {
  id: string;
  name: string;
  aliases: string[];
  normalize(number: string): string;
  track(number: string): Promise<TrackingResult>;
}
export const carrierNames = new Map<string, string>();
export class SafeError extends Error {
  constructor(message: string, readonly retryAfterSeconds?: number) { super(message); }
}
export function eventKey(fields: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}
export function safeError(error: unknown): string {
  return error instanceof SafeError ? error.message : '일시적인 내부 오류가 발생했습니다.';
}
export const formatTime = (value: string | number | null): string => value === null ? '시각 미상' :
  new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'medium', hour12: false }).format(new Date(value));
export const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
export function plain(value: string): string {
  return value.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}
export function eventLine(event: DeliveryEvent): string {
  return `${formatTime(event.time)} · ${event.label}${event.location ? ` · ${event.location}` : ''}\n${event.description}`;
}
