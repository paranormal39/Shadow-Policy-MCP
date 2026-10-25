/**
 * Shared zod schemas for MCP tool inputs. Every tool validates its arguments
 * against these; unvalidated agent input never reaches the services.
 */
import { z } from 'zod';

export const SERVICE_KINDS = ['poll.create', 'poll.premium', 'results.purchase', 'analytics'] as const;

export const agentIdSchema = z
  .string()
  .min(1)
  .max(128)
  .describe('Caller-supplied agent identifier. Bound to a pairwise DID internally.');

export const quoteSchema = z
  .object({
    quoteId: z.string(),
    agentId: z.string(),
    service: z.enum(SERVICE_KINDS),
    amountDrops: z.string(),
    asset: z.string(),
    network: z.string(),
    payTo: z.string(),
    invoiceId: z.string(),
    resource: z.string(),
    createdAt: z.number(),
    expiresAt: z.number(),
    signature: z.string(),
  })
  .describe('A server-signed quote returned by a *_pricing / prepare tool. Pass it back unchanged.');

export const receiptSchema = z.object({
  receiptId: z.string(),
  invoiceId: z.string(),
  quoteId: z.string(),
  agentId: z.string(),
  service: z.enum(SERVICE_KINDS),
  amountDrops: z.string(),
  asset: z.string(),
  network: z.string(),
  txHash: z.string(),
  payer: z.string().optional(),
  resource: z.string(),
  onChainVerified: z.boolean(),
  facilitator: z.enum(['mock', 't54']),
  settledAt: z.number(),
  signature: z.string(),
});

const pollQuestionSchema = z.object({
  prompt: z.string().min(1).max(200),
  options: z.array(z.string().min(1).max(80)).min(2).max(6),
  type: z.enum(['single', 'multi', 'stars']).optional(),
});

// Weaker LLMs often send empty arrays for unused optional fields; treat an
// empty array as "omitted" so it doesn't trip the min-length checks.
const emptyToUndef = (v: unknown) => (Array.isArray(v) && v.length === 0 ? undefined : v);

export const pollInputSchema = z.object({
  title: z.string().min(3).max(120),
  description: z.string().max(1000).optional(),
  kind: z.enum(['single', 'survey']).default('single'),
  options: z.preprocess(emptyToUndef, z.array(z.string().min(1).max(80)).min(2).max(8)).optional(),
  questions: z.preprocess(emptyToUndef, z.array(pollQuestionSchema).min(1).max(6)).optional(),
  segments: z.preprocess(emptyToUndef, z.array(z.string().min(1).max(80)).min(2).max(16)).optional(),
  eligibility: z
    .object({ method: z.enum(['open', 'qr_rotating', 'token', 'code', 'discord', 'wallet']).default('open') })
    .passthrough()
    .optional(),
  tags: z.array(z.string()).optional(),
  deadlineSeconds: z.number().int().optional(),
});

export type PollInput = z.infer<typeof pollInputSchema>;
