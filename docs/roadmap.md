# Roadmap

Phases 1–4 are implemented. This doc records what each phase delivers and what remains for a
hardened production build. The architecture — signed quotes, the `PaymentFacilitator` seam,
the `PolicyEngine`, orders/receipts, idempotency — extended into the later phases without
rework.

## Phase 1 — Working product ✅

MCP server · AgilityCore integration · Shadow Polls adapter · x402 payment flow · poll
creation & responses · auto-publish · authorization & signed receipts · stdio + HTTP
transports · sample agent · tests.

## Phase 2 — Research marketplace ✅

- Agent registry (`src/services/agents`): pairwise-DID identity, disclosed capabilities/roles.
- Agent-to-agent surveys: `shadow_create_poll audience:"agents"` restricts responses to
  registered agents.
- Response **provenance** (`src/services/provenance`): each proxied response tagged agent vs
  human; purchased results carry a provenance summary so AI answers are never passed off as
  human evidence.
- Paid **analytics** (`src/services/analytics`): privacy-preserving aggregates (option
  percentages, per-question breakdowns) released only after a paid invoice **and** explicit
  `dataUseConsent`.
- *Remaining for production:* provider-published pricing; richer eligibility by capability;
  durable stores.

## Phase 3 — Agent governance ✅

Tools over votechain's `/api/orgs` + `/api/proposals`: `shadow_list_daos`, `shadow_get_dao`,
`shadow_list_dao_members`, `shadow_create_dao` (via `/api/projects`), `shadow_join_dao`,
`shadow_create_proposal`, `shadow_get_proposals`, `shadow_get_proposal`, `shadow_cast_vote`,
`shadow_get_vote_status`, `shadow_execute_proposal`. Votes stay private (aggregate tallies
only). *Remaining:* delegation, `shadow_get_dao_policy`, richer role gating in `PolicyEngine`.

## Phase 4 — Treasury ✅

Tools: `shadow_get_treasury_balance`, `shadow_create_treasury_request`,
`shadow_approve_treasury_request`, `shadow_execute_treasury_payment`,
`shadow_get_treasury_history`.

**Hard rule enforced** (`src/services/treasury`): a treasury payment is never executable just
because an agent calls a tool. Execution is refused unless the spend has the configured number
of **distinct approvals** (`TREASURY_APPROVALS_REQUIRED`) and, by default, a **finalized
governance proposal** (`TREASURY_REQUIRE_PROPOSAL`); executed spends can't be re-run.
*Remaining:* emergency-stop / override roles, budget envelopes per DAO, on-chain settlement
proof for the treasury tx itself.

## Cross-cutting (as phases land)

- Durable stores for orders/policy/idempotency.
- Midnight / zero-knowledge integration for private membership, ballots, and treasury
  authorization (AgilityCore already ships Midnight primitives).
- Agent reputation & accountability.
- Mainnet facilitator + RLUSD / issued-asset support (the x402 types already carry `asset`).
