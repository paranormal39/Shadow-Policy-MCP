/**
 * Phase 4 — treasury tools over votechain's /api/orgs/{id}/treasury endpoints.
 *
 * HARD RULE (enforced in services/treasury + operations): a treasury payment is
 * NEVER executable just because an agent calls a tool. Execution requires the
 * configured number of distinct approvals and (by policy) a finalized governance
 * proposal. shadow_approve_treasury_request is intended for human/governance
 * approvers, not the spending agent.
 */
import { z } from 'zod';
import { defineTool, type AnyToolDef } from '../../server/registry.js';
import { approveTreasuryRequest, createTreasuryRequest, executeTreasuryPayment } from '../../services/operations.js';
import { resolveDaoId } from '../shared.js';

const walletSchema = z.string().min(3).max(120);
const daoIdSchema = z.string().min(1).optional().describe('DAO/org id. Defaults to the configured Legion DAO (LEGION_ORG_ID) when omitted.');

export const treasuryTools: AnyToolDef[] = [
  defineTool({
    name: 'shadow_get_treasury_balance',
    description: 'Get (or initialise) a DAO\u2019s treasury ledger account.',
    inputShape: { daoId: daoIdSchema },
    handler: (ctx, args) => ctx.shadowlabz.getTreasury(resolveDaoId(ctx, args.daoId)),
  }),

  defineTool({
    name: 'shadow_create_treasury_request',
    description:
      'Create a treasury spend request. Returns a spendRequestId plus the approval policy (how many approvals are needed and whether a finalized proposal is required). This does NOT move money.',
    callerWalletField: 'requestedBy',
    inputShape: {
      daoId: daoIdSchema,
      amount: z.union([z.string(), z.number()]),
      recipientAddress: walletSchema,
      purpose: z.string().min(1).max(500),
      requestedBy: walletSchema,
      currency: z.string().max(20).optional(),
      proposalId: z.string().optional().describe('Governance proposal authorising this spend (required by default policy).'),
      privacyMode: z.enum(['public', 'hybrid', 'private']).optional(),
    },
    handler: (ctx, args) =>
      createTreasuryRequest(ctx, {
        orgId: resolveDaoId(ctx, args.daoId),
        amount: String(args.amount),
        currency: args.currency,
        recipientAddress: args.recipientAddress,
        purpose: args.purpose,
        requestedBy: args.requestedBy,
        proposalId: args.proposalId,
        privacyMode: args.privacyMode,
      }),
  }),

  defineTool({
    name: 'shadow_approve_treasury_request',
    description:
      'Record a distinct approval for a treasury spend request. Intended for a human / governance approver (not the spending agent). Returns how many approvals are collected vs required.',
    inputShape: {
      spendRequestId: z.string().min(1),
      approver: z.string().min(1).max(120).describe('Identity of the approving human/governance member.'),
    },
    handler: (ctx, args) => approveTreasuryRequest(ctx, args.spendRequestId, args.approver),
  }),

  defineTool({
    name: 'shadow_execute_treasury_payment',
    description:
      'Execute a treasury payment. REFUSED unless the spend has the required distinct approvals and (by policy) a finalized governance proposal. Idempotent per spend request.',
    callerWalletField: 'authorisedBy',
    inputShape: {
      spendRequestId: z.string().min(1),
      authorisedBy: walletSchema,
      txHash: z.string().max(200).optional(),
    },
    handler: (ctx, args) => executeTreasuryPayment(ctx, { spendRequestId: args.spendRequestId, authorisedBy: args.authorisedBy, txHash: args.txHash }),
  }),

  defineTool({
    name: 'shadow_get_treasury_history',
    description: 'Get the DAO\u2019s treasury ledger (deposits + spend requests).',
    inputShape: { daoId: daoIdSchema },
    handler: (ctx, args) => ctx.shadowlabz.getTreasury(resolveDaoId(ctx, args.daoId)),
  }),
];
