/**
 * Phase 3 — governance tools: proposals + voting, over votechain's
 * /api/orgs/{id}/proposals and /api/proposals/{pid} endpoints (see API.md).
 * Votes are private (the backend only ever exposes aggregate tallies).
 */
import { z } from 'zod';
import { defineTool, type AnyToolDef } from '../../server/registry.js';
import { resolveDaoId } from '../shared.js';
import { castVote, getMyVote } from '../../services/governance.js';

const walletSchema = z.string().min(3).max(120);
const daoIdSchema = z.string().min(1).optional().describe('DAO/org id. Defaults to the configured Legion DAO (LEGION_ORG_ID) when omitted.');

export const governanceTools: AnyToolDef[] = [
  defineTool({
    name: 'shadow_create_proposal',
    description: 'Create a governance proposal in a DAO.',
    callerWalletField: 'createdBy',
    inputShape: {
      daoId: daoIdSchema,
      createdBy: walletSchema,
      title: z.string().min(3).max(200),
      description: z.string().min(1).max(4000),
      type: z.enum(['general', 'treasury']).optional(),
      votingPeriodDays: z.number().int().min(1).max(90).optional(),
      votingPeriodHours: z.number().int().min(1).max(2160).optional(),
      quorumWeightPercent: z.number().min(0).max(100).optional(),
    },
    handler: (ctx, args) => {
      const { daoId, ...body } = args;
      return ctx.shadowlabz.createProposal(resolveDaoId(ctx, daoId), body as Record<string, unknown>);
    },
  }),

  defineTool({
    name: 'shadow_get_proposals',
    description: 'List proposals for a DAO.',
    inputShape: { daoId: daoIdSchema },
    handler: (ctx, args) => ctx.shadowlabz.listProposals(resolveDaoId(ctx, args.daoId)),
  }),

  defineTool({
    name: 'shadow_get_proposal',
    description: 'Get a proposal detail (aggregate tally only — never per-voter choices).',
    inputShape: { proposalId: z.string().min(1) },
    handler: (ctx, args) => ctx.shadowlabz.getProposal(args.proposalId),
  }),

  defineTool({
    name: 'shadow_cast_vote',
    description: 'Cast a private vote on a proposal (yes/no/abstain). One vote per wallet; duplicates are rejected by the backend. A VOTE_OUTCOME_UNKNOWN error may mean the vote was recorded: do not automatically retry. ALREADY_VOTED confirms prior participation, not the requested choice.',
    callerWalletField: 'walletAddress',
    inputShape: {
      proposalId: z.string().min(1),
      walletAddress: walletSchema,
      choice: z.enum(['yes', 'no', 'abstain']),
    },
    handler: (ctx, args) => castVote(ctx.shadowlabz, args.proposalId, { walletAddress: args.walletAddress, choice: args.choice }),
  }),

  defineTool({
    name: 'shadow_get_vote_status',
    description: 'Get a proposal\u2019s current status and aggregate tally. This cannot determine whether you have voted and must not be used to decide whether to retry a vote.',
    inputShape: { proposalId: z.string().min(1) },
    handler: (ctx, args) => ctx.shadowlabz.getProposal(args.proposalId),
  }),

  defineTool({
    name: 'shadow_get_my_vote',
    description: 'Check your own participation in a proposal, never your ballot choice. Currently fails with VOTE_VERIFICATION_UNAVAILABLE because the backend integration has no authoritative participation lookup. This means unknown, not that you have not voted. Do not submit or retry based on this error.',
    callerWalletField: 'walletAddress',
    inputShape: {
      proposalId: z.string().min(1),
      walletAddress: walletSchema.optional().describe('Local caller wallet; hosted calls always use the token-bound wallet.'),
    },
    handler: (_ctx, args) => getMyVote(args.walletAddress),
  }),

  defineTool({
    name: 'shadow_execute_proposal',
    description: 'Drive a proposal\u2019s lifecycle: activate (open voting) or finalize (close + tally).',
    inputShape: { proposalId: z.string().min(1), action: z.enum(['activate', 'finalize']) },
    handler: (ctx, args) => ctx.shadowlabz.proposalStatus(args.proposalId, { action: args.action }),
  }),
];
