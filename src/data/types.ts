/**
 * Domain model for a direct-to-consumer (DTC) ecommerce store.
 *
 * All money values are in the store currency (USD) as floating-point numbers.
 * Rounding happens only at the edges (tool output), never inside calculations.
 * Dates are ISO calendar dates (`YYYY-MM-DD`) in the store's time zone.
 */

export const CHANNELS = ['meta', 'google', 'tiktok', 'email', 'organic'] as const;
export type Channel = (typeof CHANNELS)[number];

export const PAID_CHANNELS: readonly Channel[] = ['meta', 'google', 'tiktok'];

export type PaymentGateway = 'shopify_payments' | 'paypal';

export interface Product {
  sku: string;
  name: string;
  category: string;
  /** List price charged to the customer. */
  price: number;
  /** Landed unit cost (product + freight + duties). */
  unitCost: number;
  /** Shipping weight in pounds, used to allocate shipping cost. */
  weightLb: number;
}

export interface OrderLine {
  sku: string;
  qty: number;
  unitPrice: number;
  /** Line-level discount amount (already allocated from any order discount code). */
  discount: number;
  refundedQty: number;
  refundAmount: number;
}

export interface Order {
  id: string;
  date: string;
  customerId: string;
  isNewCustomer: boolean;
  /** Last-touch attributed acquisition channel. */
  channel: Channel;
  discountCode: string | null;
  gateway: PaymentGateway;
  lines: OrderLine[];
  /** Shipping charged to the customer. */
  shippingCharged: number;
  /** Carrier cost paid by the store. */
  shippingCost: number;
  /** Pick, pack and packaging cost paid to the 3PL. */
  fulfillmentCost: number;
  /** Payment processing fees. */
  paymentFee: number;
}

export interface AdSpend {
  date: string;
  channel: Channel;
  spend: number;
}

export interface InventoryPosition {
  sku: string;
  onHand: number;
  /** Supplier lead time from PO to stock available, in days. */
  leadTimeDays: number;
  /** Minimum order quantity at the supplier. */
  moq: number;
  /** Units per carton; order quantities round up to this. */
  casePack: number;
}

export interface PurchaseOrder {
  id: string;
  sku: string;
  qty: number;
  unitCost: number;
  orderedOn: string;
  expectedArrival: string;
  /** Share of the PO value already paid as a deposit. */
  depositPaidPct: number;
}

export interface DatasetMeta {
  storeName: string;
  currency: 'USD';
  seed: number;
  startDate: string;
  /** Last day with data. Every "last N days" window ends here. */
  asOf: string;
}

export interface Dataset {
  meta: DatasetMeta;
  products: Product[];
  orders: Order[];
  adSpend: AdSpend[];
  inventory: InventoryPosition[];
  purchaseOrders: PurchaseOrder[];
}
