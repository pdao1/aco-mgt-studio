import type { ActiveShipmentRecord, Repository } from '../database/repository.js';
import { CompositeCarrierTrackingProvider } from './providers.js';

/**
 * Poll carrier APIs outside the request path. A missing carrier credential or
 * a single provider failure never interrupts Gmail ingestion.
 */
export class TrackingSyncCoordinator {
  private pollTimer: NodeJS.Timeout | null = null;
  private running = false;
  private result = { lastCheckedAt: null as string | null, checked: 0, updated: 0, failed: 0, message: null as string | null };
  get summary() { return { ...this.result, running: this.running }; }

  constructor(
    private readonly repository: Repository,
    private readonly workspaceId: string,
    private readonly provider: CompositeCarrierTrackingProvider,
    private readonly maxShipmentsPerSync = 100,
  ) {}

  startPolling(intervalMinutes: number) {
    if (this.pollTimer || !this.provider.configured) return;
    this.pollTimer = setInterval(() => void this.syncAll(), intervalMinutes * 60_000);
    this.pollTimer.unref();
    void this.syncAll();
  }

  stopPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  async syncAll() {
    if (!this.provider.configured) {
      this.result.message='Carrier APIs are not connected yet. Email updates and tracking links remain available.';
      return this.summary;
    }
    if (this.running || (this.result.lastCheckedAt && Date.now()-Date.parse(this.result.lastCheckedAt)<60_000)) return this.summary;
    this.running = true;
    try {
      const shipments = await this.repository.listActiveShipments(this.workspaceId, this.maxShipmentsPerSync);
      let updated=0, failed=0;
      for (const shipment of shipments) {
        const result=await this.syncOne(shipment);
        if (result==='updated') updated++;
        if (result==='failed') failed++;
      }
      this.result={lastCheckedAt:new Date().toISOString(),checked:shipments.length,updated,failed,
        message:failed ? 'Some carrier updates were unavailable. Email statuses are preserved; carrier access or credentials may need attention.' : null};
    } finally {
      this.running = false;
    }
    return this.summary;
  }

  private async syncOne(shipment: ActiveShipmentRecord) {
    try {
      const snapshot = await this.provider.track(shipment.carrier, shipment.trackingNumber);
      if (snapshot) {
        await this.repository.updateShipmentFromCarrier(this.workspaceId, shipment, snapshot);
        return 'updated';
      }
      return 'skipped';
    } catch (error) {
      // Keep this log deliberately small: never include carrier credentials or
      // a full API response. The next polling pass retries the shipment.
      const reason = error instanceof Error ? error.message.replace(/[\r\n]+/g, ' ').slice(0, 120) : 'provider error';
      console.warn(`[tracking-sync] provider=${this.provider.name} tracking=${maskTracking(shipment.trackingNumber)} reason=${reason}`);
      return 'failed';
    }
  }
}

function maskTracking(value: string): string {
  return value.length <= 8 ? value : `${value.slice(0, 4)}…${value.slice(-4)}`;
}
