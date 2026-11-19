import type { Dataset, InventoryPosition, Product, PurchaseOrder } from '../data/types.js';
import type { Assumptions } from './assumptions.js';
import { addDays, daysBetween, trailingRange } from './dates.js';
import { contribution, lineEconomicsInRange } from './economics.js';

export type InventoryStatus = 'stockout_risk' | 'reorder_now' | 'overstock' | 'healthy';

export interface SkuDemand {
  /** Units sold per day over the velocity window. */
  dailyVelocity: number;
  /** Average net revenue per unit sold. */
  netRevenuePerUnit: number;
  /** Average CM2 (contribution before ads) per unit sold. */
  cm2PerUnit: number;
}

export interface InventoryAlert {
  sku: string;
  name: string;
  status: InventoryStatus;
  onHand: number;
  inbound: { poId: string; qty: number; expectedArrival: string; daysUntilArrival: number }[];
  dailyVelocity: number;
  daysOfCover: number | null;
  projectedStockoutDate: string | null;
  leadTimeDays: number;
  reorderPoint: number;
  inventoryPosition: number;
  /** Days with no stock before replenishment can land (0 when covered). */
  stockoutGapDays: number;
  /** Contribution (CM2) lost during the stockout gap. */
  lostContributionEstimate: number;
  recommendedOrderQty: number;
  recommendedOrderValue: number;
  inventoryValue: number;
  /** Value of stock above the overstock threshold. */
  excessInventoryValue: number;
  monthlyHoldingCostOfExcess: number;
  reason: string;
}

export interface InventoryReport {
  asOf: string;
  velocityWindowDays: number;
  alerts: InventoryAlert[];
  summary: Record<InventoryStatus, number> & { totalInventoryValue: number; totalRecommendedOrderValue: number };
}

const STATUS_ORDER: Record<InventoryStatus, number> = { stockout_risk: 0, reorder_now: 1, overstock: 2, healthy: 3 };

export function computeSkuDemand(
  dataset: Dataset,
  assumptions: Assumptions,
  windowDays: number,
): Map<string, SkuDemand> {
  const rows = lineEconomicsInRange(dataset, assumptions, trailingRange(dataset.meta.asOf, windowDays));
  const acc = new Map<string, { units: number; netRevenue: number; cm2: number }>();
  for (const row of rows) {
    const a = acc.get(row.sku) ?? { units: 0, netRevenue: 0, cm2: 0 };
    a.units += row.units;
    a.netRevenue += row.netRevenue;
    a.cm2 += contribution(row).cm2;
    acc.set(row.sku, a);
  }
  const demand = new Map<string, SkuDemand>();
  for (const product of dataset.products) {
    const a = acc.get(product.sku) ?? { units: 0, netRevenue: 0, cm2: 0 };
    demand.set(product.sku, {
      dailyVelocity: a.units / windowDays,
      netRevenuePerUnit: a.units > 0 ? a.netRevenue / a.units : product.price,
      cm2PerUnit: a.units > 0 ? a.cm2 / a.units : 0,
    });
  }
  return demand;
}

/** Rounds a desired quantity up to the case pack and the supplier MOQ. */
export function roundOrderQty(desired: number, position: Pick<InventoryPosition, 'moq' | 'casePack'>): number {
  if (desired <= 0) return 0;
  const cased = Math.ceil(desired / position.casePack) * position.casePack;
  return Math.max(cased, Math.ceil(position.moq / position.casePack) * position.casePack);
}

export interface ReorderInputs {
  onHand: number;
  inboundQty: number;
  /** Days until the earliest open PO lands, or null when nothing is inbound. */
  daysToFirstInbound: number | null;
  dailyVelocity: number;
  leadTimeDays: number;
}

/**
 * Pure reorder math for one SKU. Separated from dataset plumbing so the
 * formulas are easy to unit test.
 */
export function evaluateReorder(inputs: ReorderInputs, assumptions: Assumptions, position: Pick<InventoryPosition, 'moq' | 'casePack'>) {
  const { onHand, inboundQty, daysToFirstInbound, dailyVelocity, leadTimeDays } = inputs;
  const daysOfCover = dailyVelocity > 0 ? onHand / dailyVelocity : null;
  const reorderPoint = dailyVelocity * (leadTimeDays + assumptions.safetyStockDays);
  const inventoryPosition = onHand + inboundQty;

  // Earliest day new stock can land: an open PO, or a PO placed today.
  const replenishmentDay =
    daysToFirstInbound === null ? leadTimeDays : Math.min(daysToFirstInbound, leadTimeDays);
  const stockoutGapDays = daysOfCover === null ? 0 : Math.max(0, replenishmentDay - daysOfCover);

  const needsReorder = dailyVelocity > 0 && inventoryPosition <= reorderPoint;
  const desired = dailyVelocity * (leadTimeDays + assumptions.safetyStockDays + assumptions.targetCoverDays) - inventoryPosition;
  const recommendedOrderQty = needsReorder || stockoutGapDays > 0 ? roundOrderQty(desired, position) : 0;

  let status: InventoryStatus = 'healthy';
  if (stockoutGapDays > 0) status = 'stockout_risk';
  else if (needsReorder) status = 'reorder_now';
  else if (daysOfCover !== null && daysOfCover > assumptions.overstockDays) status = 'overstock';
  else if (daysOfCover === null && onHand > 0) status = 'overstock';

  const excessUnits =
    status === 'overstock' ? Math.max(0, onHand - dailyVelocity * assumptions.overstockDays) : 0;

  return { daysOfCover, reorderPoint, inventoryPosition, stockoutGapDays, recommendedOrderQty, status, excessUnits };
}

export function computeInventoryAlerts(
  dataset: Dataset,
  assumptions: Assumptions,
  velocityWindowDays = 28,
): InventoryReport {
  const asOf = dataset.meta.asOf;
  const demand = computeSkuDemand(dataset, assumptions, velocityWindowDays);
  const products = new Map<string, Product>(dataset.products.map((p) => [p.sku, p]));
  const openPos = dataset.purchaseOrders.filter((po) => po.expectedArrival > asOf);

  const alerts: InventoryAlert[] = dataset.inventory.map((position) => {
    const product = products.get(position.sku);
    if (!product) throw new Error(`Inventory references unknown SKU ${position.sku}`);
    const d = demand.get(position.sku) ?? { dailyVelocity: 0, netRevenuePerUnit: product.price, cm2PerUnit: 0 };
    const inbound = openPos
      .filter((po: PurchaseOrder) => po.sku === position.sku)
      .sort((a, b) => a.expectedArrival.localeCompare(b.expectedArrival))
      .map((po) => ({
        poId: po.id,
        qty: po.qty,
        expectedArrival: po.expectedArrival,
        daysUntilArrival: daysBetween(asOf, po.expectedArrival),
      }));
    const r = evaluateReorder(
      {
        onHand: position.onHand,
        inboundQty: inbound.reduce((a, po) => a + po.qty, 0),
        daysToFirstInbound: inbound[0]?.daysUntilArrival ?? null,
        dailyVelocity: d.dailyVelocity,
        leadTimeDays: position.leadTimeDays,
      },
      assumptions,
      position,
    );

    const excessInventoryValue = r.excessUnits * product.unitCost;
    const lostContributionEstimate = r.stockoutGapDays * d.dailyVelocity * d.cm2PerUnit;
    const projectedStockoutDate = r.daysOfCover === null ? null : addDays(asOf, Math.floor(r.daysOfCover));

    return {
      sku: position.sku,
      name: product.name,
      status: r.status,
      onHand: position.onHand,
      inbound,
      dailyVelocity: d.dailyVelocity,
      daysOfCover: r.daysOfCover,
      projectedStockoutDate,
      leadTimeDays: position.leadTimeDays,
      reorderPoint: r.reorderPoint,
      inventoryPosition: r.inventoryPosition,
      stockoutGapDays: r.stockoutGapDays,
      lostContributionEstimate,
      recommendedOrderQty: r.recommendedOrderQty,
      recommendedOrderValue: r.recommendedOrderQty * product.unitCost,
      inventoryValue: position.onHand * product.unitCost,
      excessInventoryValue,
      monthlyHoldingCostOfExcess: (excessInventoryValue * assumptions.inventoryHoldingCostAnnualPct) / 12,
      reason: explain(r.status, r.daysOfCover, r.stockoutGapDays, position.leadTimeDays, inbound[0]?.daysUntilArrival ?? null, assumptions),
    };
  });

  alerts.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.lostContributionEstimate - a.lostContributionEstimate);

  const count = (status: InventoryStatus): number => alerts.filter((a) => a.status === status).length;
  return {
    asOf,
    velocityWindowDays,
    alerts,
    summary: {
      stockout_risk: count('stockout_risk'),
      reorder_now: count('reorder_now'),
      overstock: count('overstock'),
      healthy: count('healthy'),
      totalInventoryValue: alerts.reduce((a, x) => a + x.inventoryValue, 0),
      totalRecommendedOrderValue: alerts.reduce((a, x) => a + x.recommendedOrderValue, 0),
    },
  };
}

function explain(
  status: InventoryStatus,
  daysOfCover: number | null,
  gapDays: number,
  leadTimeDays: number,
  daysToInbound: number | null,
  assumptions: Assumptions,
): string {
  const cover = daysOfCover === null ? 'no recent sales' : `${Math.round(daysOfCover)} days of cover`;
  switch (status) {
    case 'stockout_risk':
      return daysToInbound !== null && daysToInbound < leadTimeDays
        ? `${cover}, but the next PO lands in ${daysToInbound} days: about ${Math.round(gapDays)} days out of stock. Expedite the open PO or air-freight a top-up.`
        : `${cover} against a ${leadTimeDays}-day lead time: about ${Math.round(gapDays)} days out of stock even if ordered today. Order now and consider expedited freight.`;
    case 'reorder_now':
      return `${cover}; stock plus inbound is below the reorder point (lead time ${leadTimeDays}d + ${assumptions.safetyStockDays}d safety stock).`;
    case 'overstock':
      return `${cover}, above the ${assumptions.overstockDays}-day overstock threshold. Cash is tied up; consider a bundle, a promotion or pausing reorders.`;
    case 'healthy':
      return `${cover}; no action needed.`;
  }
}
