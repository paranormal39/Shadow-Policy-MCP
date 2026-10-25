/**
 * MVP payment tools (x402 / XRPL).
 */
import { z } from 'zod';
import { defineTool, type AnyToolDef } from '../../server/registry.js';
import { agentIdSchema, quoteSchema, receiptSchema, SERVICE_KINDS } from '../../schemas/index.js';
import { dropsToXrp } from '../../security/money.js';
import {
  approveInvoice,
  executePayment,
  getQuote,
  getReceipt,
  requestAuthorization,
  sanitizeOrder,
  verifyReceipt,
} from '../../services/operations.js';
import type { Quote, ServiceKind } from '../../services/pricing/index.js';
import type { Receipt } from '../../services/receipts/index.js';
import { X402_HEADERS, encodeHeader } from '../../integrations/xrpl/x402-types.js';

export const paymentTools: AnyToolDef[] = [
  defineTool({
    name: 'shadow_get_payment_quote',
    description:
      'Request a server-signed, immutable quote for a paid service (poll.create, poll.premium, results.purchase, analytics). Returns the quote plus the x402 PAYMENT-REQUIRED challenge. The amount cannot be altered.',
    inputShape: {
      agentId: agentIdSchema,
      service: z.enum(SERVICE_KINDS),
      resource: z.string().max(200).optional().describe('Optional resource id, e.g. "poll:<id>:results" for results.purchase.'),
    },
    handler: (ctx, args) => {
      const { quote, paymentRequired } = getQuote(ctx, args.agentId, args.service as ServiceKind, args.resource);
      return {
        quote,
        amountXrp: dropsToXrp(quote.amountDrops),
        paymentRequired,
        headers: { [X402_HEADERS.required]: encodeHeader(paymentRequired) },
        next: 'Call shadow_request_payment_authorization, then shadow_execute_payment with this quote.',
      };
    },
  }),

  defineTool({
    name: 'shadow_request_payment_authorization',
    description:
      'Check the quote against the agent spending policy (per-tx / daily / monthly limits, allowed destinations, human-approval threshold). Does not move money.',
    inputShape: { agentId: agentIdSchema, quote: quoteSchema },
    handler: (ctx, args) => {
      const decision = requestAuthorization(ctx, args.agentId, args.quote as Quote);
      const limits = ctx.policy.getLimits(args.agentId);
      return {
        decision,
        limitsXrp: {
          perTx: dropsToXrp(limits.perTxLimitDrops),
          daily: dropsToXrp(limits.dailyLimitDrops),
          monthly: dropsToXrp(limits.monthlyLimitDrops),
          humanApprovalAtOrAbove: dropsToXrp(limits.humanApprovalDrops),
        },
      };
    },
  }),

  defineTool({
    name: 'shadow_approve_payment',
    description:
      'Record an out-of-band HUMAN approval for a high-value invoice (one whose amount is at/above the human-approval threshold), so it can subsequently be authorized. Intended for a human operator, not the agent.',
    inputShape: { invoiceId: z.string().min(1) },
    handler: (ctx, args) => {
      approveInvoice(ctx, args.invoiceId);
      return { approved: true, invoiceId: args.invoiceId };
    },
  }),

  defineTool({
    name: 'shadow_execute_payment',
    description:
      'Settle an authorized quote via the x402 facilitator and return a signed receipt. Provide the base64 PAYMENT-SIGNATURE from your wallet, or (mock facilitator only) set simulate=true to have the server synthesise a mock payment for testing.',
    inputShape: {
      agentId: agentIdSchema,
      quote: quoteSchema,
      paymentSignature: z.string().optional().describe('base64 x402 PAYMENT-SIGNATURE header from the paying wallet.'),
      simulate: z.boolean().optional().describe('Mock facilitator only: synthesise a mock-signed payment.'),
    },
    handler: async (ctx, args) => {
      const { order, receipt } = await executePayment(ctx, {
        agentId: args.agentId,
        quote: args.quote as Quote,
        paymentSignature: args.paymentSignature,
        simulate: args.simulate,
      });
      return {
        receipt,
        payment: order.payment,
        order: sanitizeOrder(order),
        headers: { [X402_HEADERS.response]: encodeHeader({ success: true, txHash: order.payment?.txHash, network: order.payment?.network }) },
      };
    },
  }),

  defineTool({
    name: 'shadow_verify_payment',
    description: 'Verify the recorded payment/receipt for an invoice (signature + on-chain-verification status).',
    inputShape: { agentId: agentIdSchema, invoiceId: z.string().min(1) },
    handler: (ctx, args) => {
      const receipt = getReceipt(ctx, args.agentId, args.invoiceId);
      return { verified: verifyReceipt(ctx, receipt), onChainVerified: receipt.onChainVerified, receipt };
    },
  }),

  defineTool({
    name: 'shadow_get_payment_receipt',
    description: 'Fetch the signed receipt for a paid invoice.',
    inputShape: { agentId: agentIdSchema, invoiceId: z.string().min(1) },
    handler: (ctx, args) => getReceipt(ctx, args.agentId, args.invoiceId),
  }),

  defineTool({
    name: 'shadow_verify_payment_receipt',
    description: 'Verify a receipt object was issued by this server and was not tampered with.',
    inputShape: { receipt: receiptSchema },
    handler: (ctx, args) => ({ valid: verifyReceipt(ctx, args.receipt as Receipt) }),
  }),

  defineTool({
    name: 'shadow_get_spending_limits',
    description: 'Return the effective spending limits and current rolling usage for an agent.',
    inputShape: { agentId: agentIdSchema },
    handler: (ctx, args) => {
      const limits = ctx.policy.getLimits(args.agentId);
      const usage = ctx.policy.usage(args.agentId);
      return {
        limitsXrp: {
          perTx: dropsToXrp(limits.perTxLimitDrops),
          daily: dropsToXrp(limits.dailyLimitDrops),
          monthly: dropsToXrp(limits.monthlyLimitDrops),
          humanApprovalAtOrAbove: dropsToXrp(limits.humanApprovalDrops),
        },
        allowedDestinations: limits.allowedDestinations,
        usageXrp: { daily: dropsToXrp(usage.dailyDrops), monthly: dropsToXrp(usage.monthlyDrops) },
      };
    },
  }),

  defineTool({
    name: 'shadow_get_payment_history',
    description: 'List the agent\u2019s orders (quotes, payments, fulfilment) newest-first. Secrets and organizer keys are never included.',
    inputShape: { agentId: agentIdSchema },
    handler: (ctx, args) => ctx.orders.listByAgent(args.agentId).map(sanitizeOrder),
  }),
];
