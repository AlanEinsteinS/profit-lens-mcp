import { CHANNELS, PAID_CHANNELS, type Channel, type Dataset } from '../data/types.js';
import type { Assumptions } from './assumptions.js';
import { previousRange, type DateRange } from './dates.js';
import {
  addInto,
  adSpendByChannel,
  contribution,
  emptyTotals,
  lineEconomicsInRange,
  pct,
  ratio,
  type MoneyTotals,
} from './economics.js';

export interface ChannelPnl extends MoneyTotals {
  channel: Channel;
  paid: boolean;
  orders: number;
  newCustomers: number;
  cm1: number;
  cm2: number;
  adSpend: number;
  cm3: number;
  cm3Pct: number;
  /** Revenue after discounts per order. */
  aov: number;
  /** Revenue after discounts / ad spend. Null for unpaid channels. */
  roas: number | null;
  /** ROAS at which CM3 is exactly zero for this channel's current margin mix. */
  breakevenRoas: number | null;
  /** Ad spend per new customer. Null for unpaid channels. */
  cac: number | null;
}

export interface ChannelPnlReport {
  range: DateRange;
  channels: ChannelPnl[];
  total: {
    orders: number;
    newCustomers: number;
    netRevenue: number;
    cm2: number;
    adSpend: number;
    cm3: number;
    cm3Pct: number;
    /** Marketing efficiency ratio: revenue after discounts / total ad spend. */
    mer: number | null;
    blendedCac: number | null;
  };
  previous: { range: DateRange; netRevenue: number; adSpend: number; cm3: number };
  change: { netRevenuePct: number; adSpendPct: number; cm3Pct: number };
}

function summarize(dataset: Dataset, assumptions: Assumptions, range: DateRange): ChannelPnl[] {
  const rows = lineEconomicsInRange(dataset, assumptions, range);
  const spend = adSpendByChannel(dataset, range);

  return CHANNELS.map((channel) => {
    const totals = emptyTotals();
    const orders = new Set<string>();
    const newCustomerOrders = new Set<string>();
    for (const row of rows) {
      if (row.channel !== channel) continue;
      addInto(totals, row);
      orders.add(row.orderId);
      if (row.isNewCustomer) newCustomerOrders.add(row.orderId);
    }
    const { cm1, cm2 } = contribution(totals);
    const adSpend = spend.get(channel) ?? 0;
    const paid = PAID_CHANNELS.includes(channel);
    const revenueAfterDiscounts = totals.grossRevenue - totals.discounts;
    const cm3 = cm2 - adSpend;
    return {
      channel,
      paid,
      orders: orders.size,
      newCustomers: newCustomerOrders.size,
      ...totals,
      cm1,
      cm2,
      adSpend,
      cm3,
      cm3Pct: pct(cm3, totals.netRevenue),
      aov: orders.size > 0 ? revenueAfterDiscounts / orders.size : 0,
      roas: paid ? ratio(revenueAfterDiscounts, adSpend) : null,
      breakevenRoas: paid && cm2 > 0 ? revenueAfterDiscounts / cm2 : null,
      cac: paid ? ratio(adSpend, newCustomerOrders.size) : null,
    };
  });
}

export function computeChannelPnl(dataset: Dataset, assumptions: Assumptions, range: DateRange): ChannelPnlReport {
  const channels = summarize(dataset, assumptions, range);
  const prevRange = previousRange(range);
  const previousChannels = summarize(dataset, assumptions, prevRange);

  const sum = (list: ChannelPnl[], pick: (c: ChannelPnl) => number): number =>
    list.reduce((acc, c) => acc + pick(c), 0);

  const netRevenue = sum(channels, (c) => c.netRevenue);
  const adSpend = sum(channels, (c) => c.adSpend);
  const cm2 = sum(channels, (c) => c.cm2);
  const cm3 = cm2 - adSpend;
  const newCustomers = sum(channels, (c) => c.newCustomers);
  const revenueAfterDiscounts = sum(channels, (c) => c.grossRevenue - c.discounts);

  const prevNetRevenue = sum(previousChannels, (c) => c.netRevenue);
  const prevAdSpend = sum(previousChannels, (c) => c.adSpend);
  const prevCm3 = sum(previousChannels, (c) => c.cm3);

  return {
    range,
    channels,
    total: {
      orders: sum(channels, (c) => c.orders),
      newCustomers,
      netRevenue,
      cm2,
      adSpend,
      cm3,
      cm3Pct: pct(cm3, netRevenue),
      mer: ratio(revenueAfterDiscounts, adSpend),
      blendedCac: ratio(adSpend, newCustomers),
    },
    previous: { range: prevRange, netRevenue: prevNetRevenue, adSpend: prevAdSpend, cm3: prevCm3 },
    change: {
      netRevenuePct: pct(netRevenue - prevNetRevenue, prevNetRevenue),
      adSpendPct: pct(adSpend - prevAdSpend, prevAdSpend),
      cm3Pct: pct(cm3 - prevCm3, Math.abs(prevCm3)),
    },
  };
}
