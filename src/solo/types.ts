import type { Customer, Order } from '../types.js';
import type { WorkspaceTheme } from '../lib/themes.js';
export type SoloOrder = Omit<Order, 'feePercent'|'feeBasis'|'customBasisCents'|'feeBasisCents'|'feeCents'|'billingStatus'|'invoiceId'>;
export interface TrackingSummary {lastCheckedAt:string|null;checked:number;updated:number;failed:number;message:string|null;running:boolean}
export interface SoloDashboard {
  account:{handle:string;displayName:string;discordLinked:boolean;discordAvailable:boolean;accessExpiresAt:string;mailboxLimit:number};
  appearance:{theme:WorkspaceTheme;accentColor:string};
  mailboxes:Customer[]; orders:SoloOrder[];
  tracking:TrackingSummary & {providers:Array<{name:string;configured:boolean}>;environment:'production'|'sandbox'};
}
