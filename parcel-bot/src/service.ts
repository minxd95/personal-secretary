import { SafeError, safeError, carrierNames, type Carrier, type TrackingResult } from './domain.ts';
import { Store } from './store.ts';

export class TrackingService {
  private inflight = new Map<number, Promise<TrackingResult>>();
  constructor(readonly store: Store, readonly carriers: Carrier[], readonly intervalMs = 900_000, private readonly now = Date.now) {
    for (const carrier of carriers) carrierNames.set(carrier.id, carrier.name);
  }
  carrier(alias: string): Carrier {
    const found = this.carriers.find(carrier => carrier.aliases.includes(alias.toLowerCase()));
    if (!found) throw new SafeError('현재 CJ대한통운만 지원합니다. 택배사는 cj로 입력해주세요.');
    return found;
  }
  refresh(shipmentId: number): Promise<TrackingResult> {
    const pending = this.inflight.get(shipmentId);
    if (pending) return pending;
    const shipment = this.store.getShipment(shipmentId);
    if (!shipment) return Promise.reject(new SafeError('삭제된 택배입니다.'));
    if (shipment.failures && shipment.next_check > this.now()) return Promise.reject(new SafeError(`${shipment.last_error} 잠시 후 재시도합니다.`));
    if (shipment.snapshot && shipment.checked_at !== null && this.now() - shipment.checked_at < 60_000) return Promise.resolve(JSON.parse(shipment.snapshot) as TrackingResult);
    const task = this.fetch(shipmentId).finally(() => this.inflight.delete(shipmentId));
    this.inflight.set(shipmentId, task);
    return task;
  }
  private async fetch(shipmentId: number): Promise<TrackingResult> {
    const shipment = this.store.getShipment(shipmentId);
    try {
      const result = await this.carrier(shipment.carrier).track(shipment.number);
      this.store.apply(shipmentId, result, this.now(), this.intervalMs);
      return result;
    } catch (error) {
      this.store.fail(shipmentId, safeError(error), this.now(), error instanceof SafeError ? error.retryAfterSeconds : undefined);
      throw error;
    }
  }
  async poll(stopping: () => boolean = () => false): Promise<void> {
    for (const shipment of this.store.due(this.now())) {
      if (stopping()) break;
      if (!this.store.active(shipment.id).length) continue;
      try { await this.refresh(shipment.id); } catch { /* Persistent error and backoff are recorded by refresh. */ }
    }
  }
  async drain(): Promise<void> { await Promise.allSettled(this.inflight.values()); }
}
