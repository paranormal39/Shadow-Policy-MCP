/**
 * High-level operations composing pricing, policy, the x402 facilitator,
 * on-chain verification, orders, and receipts. Tool handlers are thin wrappers
 * over these functions.
 *
 * Invariants enforced here:
 *   - amounts come only from server-signed quotes (agents can't set prices);
 *   - no payment without a passing policy authorization;
 *   - payment and poll creation are idempotent per invoice;
 *   - organizer keys / secrets are retained server-side, never returned.
 */
import type { ServerContext } from '../server/context.js';
import { safeLog } from '../security/secrets.js';
import { agentPairwiseDid, verifyXrplPaymentOnChain } from '../integrations/agilitycore/index.js';
import { createMockSignedBlob } from '../integrations/xrpl/mock-facilitator.js';
import { X402_VERSION, decodeHeader, type PaymentPayload, type PaymentRequired, type X402Accepted } from '../integrations/xrpl/x402-types.js';
import type { Quote, ServiceKind } from './pricing/index.js';
import type { Order } from './orders/index.js';
import type { Receipt } from './receipts/index.js';
import type { CreatePollInput, Poll } from '../integrations/shadowlabz/client.js';
import type { XrplNetwork } from '../config/index.js';
import type { PollAudience, RespondentType } from './provenance/index.js';
import { computeAnalytics, type PollAnalytics } from './analytics/index.js';

export class OperationError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'OperationError';
  }
}

function requirementsFromQuote(quote: Quote): X402Accepted {
  return {
    scheme: 'exact',
    network: quote.network,
    asset: quote.asset,
    payTo: quote.payTo,
    amount: quote.amountDrops,
    maxTimeoutSeconds: 600,
    extra: { invoiceId: quote.invoiceId },
  };
}

function paymentRequiredFromQuote(quote: Quote): PaymentRequired {
  return {
    x402Version: X402_VERSION,
    accepts: [requirementsFromQuote(quote)],
    resource: quote.resource,
    description: `Payment required for: ${quote.service}`,
  };
}

/** Public view of an order — never leaks the organizer key or raw secrets. */
export function sanitizeOrder(order: Order) {
  const { organizerKey: _omit, ...rest } = order;
  return rest;
}

// ── Pricing / quote ──────────────────────────────────────────────────────────

export function getQuote(ctx: ServerContext, agentId: string, service: ServiceKind, resource?: string) {
  const quote = ctx.pricing.createQuote(agentId, service, resource);
  ctx.orders.create(quote);
  return { quote, paymentRequired: paymentRequiredFromQuote(quote) };
}

function loadVerifiedQuote(ctx: ServerContext, quote: Quote): void {
  const check = ctx.pricing.verifyQuote(quote);
  if (!check.ok) throw new OperationError(check.reason, 'INVALID_QUOTE');
}

// ── Authorization ──────────────────────────────────────────────────────────

export function requestAuthorization(ctx: ServerContext, agentId: string, quote: Quote) {
  loadVerifiedQuote(ctx, quote);
  if (quote.agentId !== agentId) throw new OperationError('Quote belongs to a different agent.', 'AGENT_MISMATCH');
  ctx.orders.create(quote);
  const decision = ctx.policy.authorize({
    agentId,
    amountDrops: quote.amountDrops,
    invoiceId: quote.invoiceId,
    destination: quote.payTo,
    service: quote.service,
  });
  if (decision.ok) {
    ctx.orders.update(quote.invoiceId, { status: 'authorized', authorizationId: decision.authorizationId });
  }
  return decision;
}

/** Record an out-of-band human approval for a high-value invoice. */
export function approveInvoice(ctx: ServerContext, invoiceId: string) {
  ctx.policy.approve(invoiceId);
}

// ── Payment ──────────────────────────────────────────────────────────────────

export interface ExecutePaymentArgs {
  agentId: string;
  quote: Quote;
  /** base64 PAYMENT-SIGNATURE header from the paying agent (real path). */
  paymentSignature?: string;
  /** Mock-only convenience: have the server synthesise a mock-signed payload. */
  simulate?: boolean;
}

export async function executePayment(ctx: ServerContext, args: ExecutePaymentArgs): Promise<{ order: Order; receipt: Receipt }> {
  const { agentId, quote } = args;
  loadVerifiedQuote(ctx, quote);
  if (quote.agentId !== agentId) throw new OperationError('Quote belongs to a different agent.', 'AGENT_MISMATCH');

  return ctx.idempotency.once(`pay:${quote.invoiceId}`, async () => {
    // Re-check policy at execution time (defence-in-depth against stale auth).
    const decision = ctx.policy.authorize({
      agentId,
      amountDrops: quote.amountDrops,
      invoiceId: quote.invoiceId,
      destination: quote.payTo,
      service: quote.service,
    });
    if (!decision.ok) throw new OperationError(decision.reason, decision.requiresHumanApproval ? 'APPROVAL_REQUIRED' : 'POLICY_DENIED');

    const requirements = requirementsFromQuote(quote);

    // Obtain the signed payment payload.
    let payload: PaymentPayload;
    if (args.paymentSignature) {
      payload = decodeHeader<PaymentPayload>(args.paymentSignature);
    } else if (ctx.facilitator.kind === 'mock' && args.simulate) {
      payload = {
        x402Version: X402_VERSION,
        accepted: requirements,
        payload: { signedTxBlob: createMockSignedBlob(requirements, agentPairwiseDid(agentId)) },
      };
    } else {
      throw new OperationError('No payment signature provided. Supply the PAYMENT-SIGNATURE header, or use simulate=true with the mock facilitator.', 'NO_PAYMENT');
    }

    const settlement = await ctx.facilitator.settle(requirements, payload);
    if (!settlement.success || !settlement.txHash) {
      ctx.orders.update(quote.invoiceId, { status: 'failed', failureReason: settlement.errorReason });
      throw new OperationError(`Payment settlement failed: ${settlement.errorReason ?? 'unknown error'}`, 'SETTLEMENT_FAILED');
    }

    // Independent on-chain verification for the real facilitator path.
    let onChainVerified = false;
    if (ctx.facilitator.kind === 't54') {
      const net: XrplNetwork = ctx.config.network;
      const check = await verifyXrplPaymentOnChain({
        network: net,
        txHash: settlement.txHash,
        destination: quote.payTo,
        expectedDrops: quote.amountDrops,
      });
      if (!check.confirmed) {
        ctx.orders.update(quote.invoiceId, { status: 'failed', failureReason: check.reason });
        throw new OperationError(`On-chain verification failed: ${check.reason}`, 'ONCHAIN_FAILED');
      }
      onChainVerified = true;
    }

    ctx.policy.recordSpend(agentId, quote.amountDrops, quote.invoiceId);

    const receipt = ctx.receipts.issue({
      invoiceId: quote.invoiceId,
      quoteId: quote.quoteId,
      agentId,
      service: quote.service,
      amountDrops: quote.amountDrops,
      asset: quote.asset,
      network: quote.network,
      txHash: settlement.txHash,
      payer: settlement.payer,
      resource: quote.resource,
      onChainVerified,
      facilitator: ctx.facilitator.kind,
    });

    const order = ctx.orders.update(quote.invoiceId, {
      status: 'paid',
      payment: {
        txHash: settlement.txHash,
        payer: settlement.payer,
        network: settlement.network ?? quote.network,
        facilitator: ctx.facilitator.kind,
        onChainVerified,
      },
      receipt,
    });

    return { order, receipt };
  });
}

function requirePaidOrder(ctx: ServerContext, agentId: string, invoiceId: string, service: ServiceKind | ServiceKind[]): Order {
  const order = ctx.orders.get(invoiceId);
  if (!order) throw new OperationError(`Unknown invoice ${invoiceId}.`, 'UNKNOWN_INVOICE');
  if (order.agentId !== agentId) throw new OperationError('Invoice belongs to a different agent.', 'AGENT_MISMATCH');
  if (order.status !== 'paid' && order.status !== 'fulfilled') {
    throw new OperationError(`Invoice ${invoiceId} is not paid (status=${order.status}).`, 'NOT_PAID');
  }
  const services = Array.isArray(service) ? service : [service];
  if (!services.includes(order.quote.service)) {
    throw new OperationError(`Invoice ${invoiceId} is for "${order.quote.service}", not ${services.join('/')}.`, 'WRONG_SERVICE');
  }
  return order;
}

// ── Fulfilment: poll creation ──────────────────────────────────────────────

export async function createPollForOrder(
  ctx: ServerContext,
  agentId: string,
  invoiceId: string,
  input: CreatePollInput,
  publish = true,
  audience: PollAudience = 'public',
): Promise<{ pollId: string; pollUrl: string; published: boolean; status: string; publishError?: string; poll: Poll }> {
  requirePaidOrder(ctx, agentId, invoiceId, ['poll.create', 'poll.premium']);
  return ctx.idempotency.once(`poll:${invoiceId}`, async () => {
    const order = requirePaidOrder(ctx, agentId, invoiceId, ['poll.create', 'poll.premium']);
    if (order.fulfilment?.pollId) {
      const poll = await ctx.shadowlabz.getPoll(order.fulfilment.pollId).catch(() => ({ id: order.fulfilment!.pollId! } as Poll));
      return {
        pollId: order.fulfilment.pollId,
        pollUrl: order.fulfilment.pollUrl!,
        published: !!order.fulfilment.published,
        status: (poll.status as string) ?? (order.fulfilment.published ? 'active' : 'draft'),
        poll,
      };
    }
    // Every poll created through this MCP flow is agent-made — tag it so
    // votechain renders the "Made by AI" badge (the backend only trusts this
    // from an authenticated API-key caller, which this server is).
    const result = await ctx.shadowlabz.createPoll({ ...input, createdByAgent: true });
    const pollUrl = `${ctx.config.shadowlabz.publicUrl}/polls/${result.poll.id}`;

    // Auto-publish: votechain creates polls as drafts and returns a one-time
    // organizer key; activating (draft -> active) needs that key, which we hold
    // server-side. Best-effort: a failed activation still leaves a valid draft.
    let published = false;
    let publishError: string | undefined;
    if (publish) {
      // Right after creation the backend can briefly 404 the activate (the poll
      // isn't queryable yet in on-chain mode) — retry with short backoff.
      const delays = [0, 1500, 3000];
      for (let i = 0; i < delays.length; i++) {
        if (delays[i]) await new Promise((r) => setTimeout(r, delays[i]));
        try {
          await ctx.shadowlabz.activatePoll(result.poll.id, result.organizerKey);
          published = true;
          publishError = undefined;
          break;
        } catch (err) {
          publishError = (err as Error).message;
        }
      }
      if (!published) safeLog.warn('auto-activate failed; poll left as draft (retry with shadow_publish_poll)', { pollId: result.poll.id, message: publishError });
    }

    if (audience === 'agents') ctx.provenance.setAudience(result.poll.id, 'agents');

    ctx.orders.update(invoiceId, {
      status: 'fulfilled',
      organizerKey: result.organizerKey, // retained server-side; never returned
      fulfilment: { pollId: result.poll.id, pollUrl, organizerKeyHeld: true, published },
    });
    return { pollId: result.poll.id, pollUrl, published, status: published ? 'active' : 'draft', publishError, poll: result.poll };
  });
}

/** Publish (activate) a previously-created poll for an order, using the held key. */
export async function activatePollForOrder(ctx: ServerContext, agentId: string, invoiceId: string): Promise<{ pollId: string; pollUrl?: string; status: string }> {
  const order = ctx.orders.get(invoiceId);
  if (!order || order.agentId !== agentId) throw new OperationError(`Unknown invoice ${invoiceId}.`, 'UNKNOWN_INVOICE');
  if (!order.fulfilment?.pollId || !order.organizerKey) throw new OperationError('No created poll to publish for this invoice.', 'NO_POLL');
  await ctx.shadowlabz.activatePoll(order.fulfilment.pollId, order.organizerKey);
  ctx.orders.update(invoiceId, { fulfilment: { ...order.fulfilment, published: true } });
  return { pollId: order.fulfilment.pollId, pollUrl: order.fulfilment.pollUrl, status: 'active' };
}

// ── Survey responses (Phase 2) ──────────────────────────────────────────────

export interface SubmitResponseArgs {
  pollId: string;
  answers: number[][];
  segment?: number;
  deviceId?: string;
  /** The responding agent (required for agent-audience polls). */
  agentId?: string;
}

export async function submitPollResponse(ctx: ServerContext, args: SubmitResponseArgs): Promise<{ pollId: string; respondentType: RespondentType; result: unknown }> {
  const audience = ctx.provenance.getAudience(args.pollId);
  const registered = args.agentId ? ctx.agents.isRegistered(args.agentId) : false;

  // Agent-audience surveys are restricted to registered agents (anti-impersonation).
  if (audience === 'agents') {
    if (!args.agentId) throw new OperationError('This survey is restricted to registered agents; provide an agentId.', 'AGENT_REQUIRED');
    if (!registered) throw new OperationError(`Agent ${args.agentId} is not registered. Call shadow_register_agent first.`, 'AGENT_NOT_REGISTERED');
  }

  const respondentType: RespondentType = registered ? 'agent' : 'human';
  const result = await ctx.shadowlabz.submitVote(args.pollId, { answers: args.answers, segment: args.segment, deviceId: args.deviceId });
  ctx.provenance.record({
    pollId: args.pollId,
    respondentType,
    agentId: args.agentId,
    capabilitiesDisclosed: args.agentId ? ctx.agents.get(args.agentId)?.capabilities : undefined,
    at: Date.now(),
  });
  return { pollId: args.pollId, respondentType, result };
}

// ── Fulfilment: results purchase ───────────────────────────────────────────

export async function releaseResultsForOrder(
  ctx: ServerContext,
  agentId: string,
  invoiceId: string,
  dataUseConsent: boolean,
): Promise<{ pollId: string; analytics: PollAnalytics; results: Poll }> {
  if (!dataUseConsent) {
    throw new OperationError('Purchasing results requires explicit data-use consent (dataUseConsent=true): aggregates only, no re-identification, respect respondent privacy.', 'CONSENT_REQUIRED');
  }
  const order = requirePaidOrder(ctx, agentId, invoiceId, ['results.purchase', 'analytics']);
  // resource encodes the poll the results were purchased for: "poll:<id>:results"
  const match = /^poll:([^:]+):/.exec(order.quote.resource);
  if (!match) throw new OperationError('This results invoice is not bound to a poll.', 'BAD_RESOURCE');
  const pollId = match[1];
  // votechain's poll detail is already aggregate (tallies only) — no private
  // voter identities or secret ballots are ever exposed. We add computed
  // analytics + a provenance summary so agent vs human responses are explicit.
  const results = await ctx.shadowlabz.getPoll(pollId);
  const analytics = computeAnalytics(results, ctx.provenance.summary(pollId));
  ctx.orders.update(invoiceId, { fulfilment: { ...order.fulfilment, pollId, resultsReleased: true } });
  return { pollId, analytics, results };
}

// ── Receipts / history ─────────────────────────────────────────────────────

export function getReceipt(ctx: ServerContext, agentId: string, invoiceId: string): Receipt {
  const order = ctx.orders.get(invoiceId);
  if (!order || order.agentId !== agentId) throw new OperationError(`Unknown invoice ${invoiceId}.`, 'UNKNOWN_INVOICE');
  if (!order.receipt) throw new OperationError(`No receipt yet for ${invoiceId}.`, 'NO_RECEIPT');
  return order.receipt;
}

export function verifyReceipt(ctx: ServerContext, receipt: Receipt): boolean {
  return ctx.receipts.verify(receipt);
}

// ── Treasury (Phase 4) ──────────────────────────────────────────────────────

function extractId(obj: unknown): string | undefined {
  if (obj && typeof obj === 'object') {
    const o = obj as Record<string, unknown>;
    const candidate = (o.spendRequestId ?? o.id ?? (o.spendRequest as Record<string, unknown> | undefined)?.id ?? (o.data as Record<string, unknown> | undefined)?.id);
    return typeof candidate === 'string' ? candidate : undefined;
  }
  return undefined;
}

export async function createTreasuryRequest(
  ctx: ServerContext,
  args: { orgId: string; amount: string; currency?: string; recipientAddress: string; purpose: string; requestedBy: string; proposalId?: string; privacyMode?: 'public' | 'hybrid' | 'private' },
): Promise<{ spendRequestId: string; approvalsRequired: number; requireProposal: boolean; backend: unknown }> {
  const backend = await ctx.shadowlabz.createSpendRequest(args.orgId, {
    amount: args.amount,
    currency: args.currency,
    recipientAddress: args.recipientAddress,
    purpose: args.purpose,
    requestedBy: args.requestedBy,
    proposalId: args.proposalId,
    privacyMode: args.privacyMode,
  });
  const spendRequestId = extractId(backend);
  if (!spendRequestId) throw new OperationError('Backend did not return a spend request id.', 'NO_SPEND_ID');
  ctx.treasury.track({
    spendRequestId,
    orgId: args.orgId,
    amount: String(args.amount),
    recipientAddress: args.recipientAddress,
    requestedBy: args.requestedBy,
    proposalId: args.proposalId,
  });
  return { spendRequestId, approvalsRequired: ctx.config.treasury.approvalsRequired, requireProposal: ctx.config.treasury.requireProposal, backend };
}

export function approveTreasuryRequest(ctx: ServerContext, spendRequestId: string, approver: string) {
  const rec = ctx.treasury.get(spendRequestId);
  if (!rec) throw new OperationError(`Unknown spend request ${spendRequestId}. Create it via shadow_create_treasury_request first.`, 'UNKNOWN_SPEND');
  const updated = ctx.treasury.approve(spendRequestId, approver);
  const need = ctx.config.treasury.approvalsRequired;
  return { spendRequestId, approvals: updated.approvals.length, approvalsRequired: need, approvers: updated.approvals, ready: updated.approvals.length >= need };
}

async function proposalIsFinalized(ctx: ServerContext, proposalId?: string): Promise<boolean> {
  if (!proposalId) return false;
  try {
    const p = (await ctx.shadowlabz.getProposal(proposalId)) as { status?: string };
    const status = (p.status ?? '').toLowerCase();
    return ['closed', 'finalized', 'passed', 'executed', 'approved'].includes(status);
  } catch {
    return false;
  }
}

export async function executeTreasuryPayment(
  ctx: ServerContext,
  args: { spendRequestId: string; authorisedBy: string; txHash?: string },
): Promise<{ executed: true; backend: unknown }> {
  const rec = ctx.treasury.get(args.spendRequestId);
  if (!rec) throw new OperationError(`Unknown spend request ${args.spendRequestId}.`, 'UNKNOWN_SPEND');

  // HARD GUARD: never execute unless the approval policy is satisfied.
  const finalized = await proposalIsFinalized(ctx, rec.proposalId);
  const gate = ctx.treasury.canExecute(args.spendRequestId, finalized);
  if (!gate.ok) throw new OperationError(`Treasury execution denied: ${gate.reason}`, 'TREASURY_DENIED');

  // Idempotent: a repeat execute returns the first result without double-paying.
  return ctx.idempotency.once(`treasury:${args.spendRequestId}`, async () => {
    const backend = await ctx.shadowlabz.executeSpend(rec.orgId, { spendRequestId: args.spendRequestId, authorisedBy: args.authorisedBy, txHash: args.txHash });
    ctx.treasury.markExecuted(args.spendRequestId);
    return { executed: true as const, backend };
  });
}
