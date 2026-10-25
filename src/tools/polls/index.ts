/**
 * MVP Shadow Polls tools.
 */
import { z } from 'zod';
import { defineTool, type AnyToolDef } from '../../server/registry.js';
import { agentIdSchema, pollInputSchema, receiptSchema } from '../../schemas/index.js';
import { dropsToXrp } from '../../security/money.js';
import { SERVICE_LABELS } from '../../services/pricing/index.js';
import {
  activatePollForOrder,
  createPollForOrder,
  getQuote,
  releaseResultsForOrder,
  submitPollResponse,
  verifyReceipt,
} from '../../services/operations.js';
import type { Receipt } from '../../services/receipts/index.js';
import type { CreatePollInput } from '../../integrations/shadowlabz/client.js';
import { X402_HEADERS, encodeHeader } from '../../integrations/xrpl/x402-types.js';

export const pollTools: AnyToolDef[] = [
  defineTool({
    name: 'shadow_list_poll_capabilities',
    description: 'Discover Shadow Polls capabilities: poll kinds, eligibility methods, and the current price list.',
    inputShape: {},
    handler: (ctx) => ({
      kinds: ['single', 'survey'],
      eligibilityMethods: ['open', 'qr_rotating', 'token', 'code', 'discord', 'wallet'],
      premiumFeatures: ['audience segments', 'multi-select / stars questions', 'up to 6 questions'],
      services: ctx.pricing.catalog().map((c) => ({ ...c, amountXrp: dropsToXrp(c.amountDrops), label: SERVICE_LABELS[c.service] })),
      network: ctx.config.caip2,
      flow: [
        'shadow_prepare_poll (get a signed quote + PAYMENT-REQUIRED)',
        'shadow_request_payment_authorization',
        'shadow_execute_payment',
        'shadow_create_poll (with the paid invoiceId)',
      ],
    }),
  }),

  defineTool({
    name: 'shadow_get_poll_pricing',
    description: 'Get the price for creating a poll (standard or premium). Pure price lookup; no quote is issued.',
    inputShape: { premium: z.boolean().optional() },
    handler: (ctx, args) => {
      const service = args.premium ? 'poll.premium' : 'poll.create';
      const drops = ctx.pricing.priceDropsFor(service);
      return { service, amountDrops: drops, amountXrp: dropsToXrp(drops), asset: ctx.config.merchantAsset, network: ctx.config.caip2 };
    },
  }),

  defineTool({
    name: 'shadow_prepare_poll',
    description:
      'Prepare to create a poll: returns a server-signed quote and the x402 PAYMENT-REQUIRED challenge. Optionally validates a poll draft up front. Pay it (authorize -> execute), then call shadow_create_poll.',
    inputShape: {
      agentId: agentIdSchema,
      premium: z.boolean().optional(),
      pollDraft: pollInputSchema.optional(),
    },
    handler: (ctx, args) => {
      const service = args.premium ? 'poll.premium' : 'poll.create';
      const { quote, paymentRequired } = getQuote(ctx, args.agentId, service, service);
      return {
        quote,
        amountXrp: dropsToXrp(quote.amountDrops),
        paymentRequired,
        headers: { [X402_HEADERS.required]: encodeHeader(paymentRequired) },
        draftValidated: args.pollDraft ? true : false,
        next: 'shadow_request_payment_authorization -> shadow_execute_payment -> shadow_create_poll(invoiceId).',
      };
    },
  }),

  defineTool({
    name: 'shadow_create_poll',
    description:
      'Create a Shadow Poll after its invoice is PAID, and (by default) publish it immediately so it is live. Returns the poll id, shareable URL, and status. Set publish=false to leave it as a draft. The one-time organizer key is retained server-side and never returned. Idempotent per invoice.',
    inputShape: {
      agentId: agentIdSchema,
      invoiceId: z.string().min(1),
      poll: pollInputSchema,
      publish: z.boolean().optional().describe('Publish (activate) the poll immediately. Default true.'),
      audience: z.enum(['public', 'agents']).optional().describe('"agents" restricts responses to registered agents (agent-to-agent survey). Default public.'),
    },
    handler: async (ctx, args) => {
      const publish = args.publish ?? true;
      const result = await createPollForOrder(ctx, args.agentId, args.invoiceId, args.poll as CreatePollInput, publish, args.audience ?? 'public');
      return {
        pollId: result.pollId,
        pollUrl: result.pollUrl,
        status: result.status,
        published: result.published,
        audience: args.audience ?? 'public',
        ...(result.publishError
          ? { publishError: result.publishError, hint: 'Poll created as a draft because publishing failed (often an on-chain activation timeout). Retry with shadow_publish_poll using the same invoiceId.' }
          : {}),
      };
    },
  }),

  defineTool({
    name: 'shadow_publish_poll',
    description:
      'Publish (activate) a poll that was created as a draft for a paid invoice (draft -> active), using the organizer key held server-side.',
    inputShape: { agentId: agentIdSchema, invoiceId: z.string().min(1) },
    handler: (ctx, args) => activatePollForOrder(ctx, args.agentId, args.invoiceId),
  }),

  defineTool({
    name: 'shadow_get_poll',
    description: 'Fetch a poll\u2019s public metadata and aggregate tallies.',
    inputShape: { pollId: z.string().min(1) },
    handler: (ctx, args) => ctx.shadowlabz.getPoll(args.pollId),
  }),

  defineTool({
    name: 'shadow_list_polls',
    description: 'List all polls (public metadata + tallies), newest first.',
    inputShape: {},
    handler: (ctx) => ctx.shadowlabz.listPolls(),
  }),

  defineTool({
    name: 'shadow_submit_poll_response',
    description:
      'Submit a private vote/response to a poll, subject to the poll\u2019s eligibility and anti-Sybil rules enforced by the backend. Answers are option indices per question. Provide agentId when responding as a registered agent (required for agent-audience surveys); the response is tagged with provenance (agent vs human).',
    inputShape: {
      pollId: z.string().min(1),
      answers: z.array(z.array(z.number().int().min(0))).min(1),
      segment: z.number().int().min(0).optional(),
      deviceId: z.string().regex(/^[0-9a-f]{16,64}$/i).optional(),
      agentId: agentIdSchema.optional(),
    },
    handler: (ctx, args) => submitPollResponse(ctx, { pollId: args.pollId, answers: args.answers, segment: args.segment, deviceId: args.deviceId, agentId: args.agentId }),
  }),

  defineTool({
    name: 'shadow_get_poll_results',
    description: 'Get the public aggregate results (tallies) of a poll. No private voter identities or secret ballots are exposed.',
    inputShape: { pollId: z.string().min(1) },
    handler: async (ctx, args) => {
      const poll = await ctx.shadowlabz.getPoll(args.pollId);
      return { pollId: args.pollId, status: poll.status, results: poll };
    },
  }),

  defineTool({
    name: 'shadow_purchase_poll_results',
    description:
      'Release authorized aggregate results + analytics for a poll after a results.purchase (or analytics) invoice is PAID. Obtain the invoice via shadow_get_payment_quote with service="results.purchase" and resource="poll:<id>:results". Requires dataUseConsent=true. Returns privacy-preserving aggregates with a provenance summary (agent vs human); never voter identities or ballots.',
    inputShape: {
      agentId: agentIdSchema,
      invoiceId: z.string().min(1),
      dataUseConsent: z.boolean().describe('Must be true: you agree to use aggregates only, not to re-identify respondents, and to respect privacy.'),
    },
    handler: async (ctx, args) => {
      const { pollId, analytics, results } = await releaseResultsForOrder(ctx, args.agentId, args.invoiceId, args.dataUseConsent);
      return { pollId, analytics, results };
    },
  }),

  defineTool({
    name: 'shadow_verify_poll_receipt',
    description: 'Verify a Shadow Policy receipt (e.g. for a poll creation or results purchase) is authentic.',
    inputShape: { receipt: receiptSchema },
    handler: (ctx, args) => ({ valid: verifyReceipt(ctx, args.receipt as Receipt) }),
  }),
];
