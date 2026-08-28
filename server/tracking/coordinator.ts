import type { ActiveShipmentRecord, Repository } from '../database/repository.js';
import { CompositeCarrierTrackingProvider } from './providers.js';

/**
 * Poll carrier APIs outside the request path. A missing carrier credential or
 * a single provider failure never interrupts Gmail ingestion.
 */
export class TrackingSyncCoordinator {
  private pollTimer: NodeJS.Timeout | null = null;
  private running = false;

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

  async syncAll(): Promise<void> {
    if (this.running || !this.provider.configured) return;
    this.running = true;
    try {
      const shipments = await this.repository.listActiveShipments(this.workspaceId, this.maxShipmentsPerSync);
      for (const shipment of shipments) await this.syncOne(shipment);
    } finally {
      this.running = false;
    }
  }

  private async syncOne(shipment: ActiveShipmentRecord) {
    try {
      const snapshot = await this.provider.track(shipment.carrier, shipment.trackingNumber);
      if (snapshot) await this.repository.updateShipmentFromCarrier(this.workspaceId, shipment, snapshot);
    } catch (error) {
      // Keep this log deliberately small: never include carrier credentials or
      // a full API response. The next polling pass retries the shipment.
      const reason = error instanceof Error ? error.message.replace(/[\r\n]+/g, ' ').slice(0, 120) : 'provider error';
      console.warn(`[tracking-sync] provider=${this.provider.name} tracking=${maskTracking(shipment.trackingNumber)} reason=${reason}`);
    }
  }
}

function maskTracking(value: string): string {
  return value.length <= 8 ? value : `${value.slice(0, 4)}…${value.slice(-4)}`;
}
