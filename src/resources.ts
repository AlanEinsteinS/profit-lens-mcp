import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';
import type { ProfitLensContext } from './context.js';
import { AssumptionsSchema } from './finance/assumptions.js';

export const SCHEMA_MARKDOWN = `# profit-lens dataset schema and metric definitions

## Entities
- **Product**: sku, name, category, price (list price, USD), unitCost (landed COGS per unit), weightLb.
- **Order**: id, date (YYYY-MM-DD), customerId, isNewCustomer, channel (last-touch: meta | google | tiktok | email | organic),
  discountCode, gateway (shopify_payments | paypal), lines[], shippingCharged, shippingCost (carrier), fulfillmentCost (3PL), paymentFee.
- **OrderLine**: sku, qty, unitPrice, discount (allocated from the order code), refundedQty, refundAmount.
- **AdSpend**: date, channel, spend (daily, paid channels only).
- **InventoryPosition**: sku, onHand, leadTimeDays, moq, casePack (snapshot at the as-of date).
- **PurchaseOrder**: id, sku, qty, unitCost, orderedOn, expectedArrival, depositPaidPct.

## Metrics
- **Net revenue** = gross revenue - discounts - refunds. Refunds are counted against the order date.
- **CM1** (gross margin) = net revenue - COGS. COGS of refunded units is recovered at \`refundRestockRate\`.
- **CM2** = CM1 - shipping subsidy (carrier cost - shipping charged) - 3PL fulfillment - payment fees.
- **CM3** = CM2 - ad spend. For SKUs, each channel's spend is allocated by that channel's attributed net revenue per SKU.
- **ROAS** = revenue after discounts / ad spend (channel, last-touch). **MER** = total revenue after discounts / total ad spend.
- **Breakeven ROAS** = revenue after discounts / CM2: the ROAS at which CM3 is zero for the channel's margin mix.
- **Marginal ROAS** = change in revenue / change in spend between two periods. Below breakeven means the extra spend loses money.
- **CAC** = ad spend / new customers (channel, last-touch).
- **Days of cover** = on hand / daily unit velocity (trailing 28 days by default).
- **Reorder point** = velocity x (lead time + safety stock days).

## Allocation rules (order costs down to lines)
- Shipping subsidy by line weight, 3PL fulfillment by units, payment fees by line revenue after discounts.
`;

export function registerResources(server: McpServer, ctx: ProfitLensContext): void {
  server.registerResource(
    'assumptions',
    'profit-lens://assumptions',
    {
      title: 'Model assumptions',
      description: 'The financial-model assumptions every tool uses (cash, opex, buffers, inventory policy), with their source.',
      mimeType: 'application/json',
    },
    (uri) => {
      const descriptions = Object.fromEntries(
        Object.entries(AssumptionsSchema.shape).map(([key, schema]) => [key, (schema as z.ZodType).description ?? '']),
      );
      const body = { source: ctx.assumptionsSource, values: ctx.assumptions, descriptions };
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(body, null, 2) }] };
    },
  );

  server.registerResource(
    'dataset-schema',
    'profit-lens://schema',
    {
      title: 'Dataset schema and metric definitions',
      description: 'Entities in the store dataset and exact definitions of CM1/CM2/CM3, ROAS, MER, CAC and the inventory math.',
      mimeType: 'text/markdown',
    },
    (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: SCHEMA_MARKDOWN }] }),
  );

  server.registerResource(
    'catalog',
    'profit-lens://catalog',
    {
      title: 'Product catalog and stock',
      description: 'Products with price and unit cost, current inventory positions and open purchase orders.',
      mimeType: 'application/json',
    },
    (uri) => {
      const body = {
        store: ctx.dataset.meta,
        products: ctx.dataset.products,
        inventory: ctx.dataset.inventory,
        purchaseOrders: ctx.dataset.purchaseOrders,
      };
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(body, null, 2) }] };
    },
  );
}
