/**
 * Order lifecycle + store. One order per quote (keyed by the quote's invoiceId):
 *   quoted -> authorized -> paid -> fulfilled   (or -> failed)
 *
 * The store is the idempotency anchor for the whole flow: a repeated payment or
 * poll-creation for the same invoice resolves to the already-recorded result
 * instead of charging/creating twice.
 */
import type { Quote } from '../pricing/index.js';
import type { Receipt } from '../receipts/index.js';

export type OrderStatus = 'quoted' | 'authorized' | 'paid' | 'fulfilled' | 'failed';

export interface PaymentInfo {
  txHash: string;
  payer?: string;
  network: string;
  facilitator: 'mock' | 't54';
  onChainVerified: boolean;
}

export interface FulfilmentInfo {
  pollId?: string;
  pollUrl?: string;
  /** Whether the one-time organizer key is retained server-side for host actions. */
  organizerKeyHeld?: boolean;
  /** Whether the poll has been activated (published) on the backend. */
  published?: boolean;
  resultsReleased?: boolean;
}

export interface Order {
  invoiceId: string;
  quote: Quote;
  agentId: string;
  status: OrderStatus;
  authorizationId?: string;
  payment?: PaymentInfo;
  receipt?: Receipt;
  fulfilment?: FulfilmentInfo;
  /** Host-action credential for a created poll — never exposed in tool output. */
  organizerKey?: string;
  failureReason?: string;
  createdAt: number;
  updatedAt: number;
}

export class OrderStore {
  private readonly byInvoice = new Map<string, Order>();

  create(quote: Quote): Order {
    const existing = this.byInvoice.get(quote.invoiceId);
    if (existing) return existing;
    const now = Date.now();
    const order: Order = {
      invoiceId: quote.invoiceId,
      quote,
      agentId: quote.agentId,
      status: 'quoted',
      createdAt: now,
      updatedAt: now,
    };
    this.byInvoice.set(quote.invoiceId, order);
    return order;
  }

  get(invoiceId: string): Order | undefined {
    return this.byInvoice.get(invoiceId);
  }

  update(invoiceId: string, patch: Partial<Order>): Order {
    const order = this.byInvoice.get(invoiceId);
    if (!order) throw new Error(`Unknown order ${invoiceId}`);
    Object.assign(order, patch, { updatedAt: Date.now() });
    return order;
  }

  /** All orders for an agent, most recent first (for payment history). */
  listByAgent(agentId: string): Order[] {
    return [...this.byInvoice.values()]
      .filter((o) => o.agentId === agentId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** All orders, most recent first (for aggregate stats; never exposed raw). */
  list(): Order[] {
    return [...this.byInvoice.values()].sort((a, b) => b.createdAt - a.createdAt);
  }
}
