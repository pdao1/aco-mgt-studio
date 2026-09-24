import { z } from 'zod';

const common = { id: z.string().regex(/^mem_/), status: z.string(), license_key: z.string().min(1).max(256).nullable() };
// Whop's documented membership shape and the dated account/ID shape used by
// existing installations normalize at this boundary. Never infer a product.
export const membershipSchema = z.union([
  z.object({ ...common, company: z.object({ id: z.string() }), product: z.object({ id: z.string() }),
    user: z.object({ id: z.string(), username: z.string().optional() }).nullable(),
    renewal_period_end: z.string().datetime({ offset: true }).nullable(),
  }).transform(m => ({ ...m, account: m.company, product_id: m.product.id, user_id: m.user?.id ?? null,
    username: m.user?.username ?? null, current_period_end: m.renewal_period_end })),
  z.object({ ...common, license_key: common.license_key.optional().default(null), account: z.object({ id: z.string() }),
    product_id: z.string(), user_id: z.string().nullable(), current_period_end: z.string().datetime({ offset: true }).nullable(),
  }).transform(m => ({ ...m, username: null as string | null })),
]);
export type Membership = z.infer<typeof membershipSchema>;
export class LicenseError extends Error {}
export interface VerifiedLicense { membershipId: string; workspaceId: string; product: 'solo' | 'aco'; licenseHash: string }
