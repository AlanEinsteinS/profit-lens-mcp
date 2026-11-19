import { z } from 'zod';

/**
 * Model assumptions: the knobs a finance lead would normally keep in a
 * "financial model" spreadsheet. Defaults are sensible for a ~$4M/yr DTC
 * brand. Any of them can be overridden from a Google Sheet (see
 * `src/integrations/sheets.ts`).
 */
export const AssumptionsSchema = z.object({
  startingCash: z.number().nonnegative().describe('Cash in bank at the as-of date (USD).'),
  monthlyOpex: z
    .number()
    .nonnegative()
    .describe('Fixed operating expenses per month: payroll, rent, software, agencies (USD).'),
  minCashBuffer: z.number().nonnegative().describe('Cash level the business must not drop below (USD).'),
  refundRestockRate: z
    .number()
    .min(0)
    .max(1)
    .describe('Share of refunded units that return to sellable stock (their COGS is recovered).'),
  inventoryHoldingCostAnnualPct: z
    .number()
    .min(0)
    .max(1)
    .describe('Annual cost of holding inventory as a share of its value (capital, storage, shrink).'),
  safetyStockDays: z.number().int().min(0).describe('Days of demand kept as safety stock.'),
  targetCoverDays: z
    .number()
    .int()
    .min(1)
    .describe('Days of demand a new purchase order should cover beyond lead time and safety stock.'),
  overstockDays: z.number().int().min(30).describe('Days of cover above which stock counts as overstock.'),
  poDepositPct: z.number().min(0).max(1).describe('Share of a new PO paid upfront; the rest is paid on arrival.'),
  paidRevenueElasticity: z
    .number()
    .min(0)
    .max(1.5)
    .describe('How strongly paid-channel revenue responds to ad spend changes in forecasts (1 = proportional).'),
});

export type Assumptions = z.infer<typeof AssumptionsSchema>;

export const DEFAULT_ASSUMPTIONS: Assumptions = {
  startingCash: 420_000,
  monthlyOpex: 92_000,
  minCashBuffer: 150_000,
  refundRestockRate: 0.5,
  inventoryHoldingCostAnnualPct: 0.25,
  safetyStockDays: 14,
  targetCoverDays: 60,
  overstockDays: 180,
  poDepositPct: 0.3,
  paidRevenueElasticity: 0.6,
};

export const PartialAssumptionsSchema = AssumptionsSchema.partial();
export type PartialAssumptions = z.infer<typeof PartialAssumptionsSchema>;

export function resolveAssumptions(...overrides: PartialAssumptions[]): Assumptions {
  const merged: Assumptions = { ...DEFAULT_ASSUMPTIONS };
  for (const override of overrides) {
    for (const [key, value] of Object.entries(override) as [keyof Assumptions, number | undefined][]) {
      if (value !== undefined) merged[key] = value;
    }
  }
  return AssumptionsSchema.parse(merged);
}
