import type { AdSpend, Channel, Dataset, Order, OrderLine, Product } from '../src/data/types.js';

export const WIDGET: Product = { sku: 'W', name: 'Widget', category: 'Test', price: 100, unitCost: 40, weightLb: 1 };
export const ANVIL: Product = { sku: 'A', name: 'Anvil', category: 'Test', price: 50, unitCost: 20, weightLb: 3 };

let seq = 0;

export function line(sku: string, qty: number, unitPrice: number, extra: Partial<OrderLine> = {}): OrderLine {
  return { sku, qty, unitPrice, discount: 0, refundedQty: 0, refundAmount: 0, ...extra };
}

export function order(fields: Partial<Order> & { lines: OrderLine[] }): Order {
  seq += 1;
  return {
    id: `#T${seq}`,
    date: '2026-01-10',
    customerId: `C${seq}`,
    isNewCustomer: true,
    channel: 'meta',
    discountCode: null,
    gateway: 'shopify_payments',
    shippingCharged: 0,
    shippingCost: 0,
    fulfillmentCost: 0,
    paymentFee: 0,
    ...fields,
  };
}

export function spend(date: string, channel: Channel, amount: number): AdSpend {
  return { date, channel, spend: amount };
}

export function makeDataset(fields: Partial<Dataset> = {}): Dataset {
  return {
    meta: { storeName: 'Fixture Store', currency: 'USD', seed: 0, startDate: '2026-01-01', asOf: '2026-01-31' },
    products: [WIDGET, ANVIL],
    orders: [],
    adSpend: [],
    inventory: [],
    purchaseOrders: [],
    ...fields,
  };
}
