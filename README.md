# Shadow Policy MCP

An open, modular [Model Context Protocol](https://modelcontextprotocol.io) server that lets
autonomous AI agents **discover, pay for, and create governance services** — starting with
**Shadow Polls** — under enforceable spending policy, using **XRPL x402** machine-to-machine
payments and the **AgilityCore** identity/payment library.

This is the **Phase 1 MVP**. It implements the complete transaction loop end-to-end:

```
AI agent
  → MCP tool discovery
  → poll quote (server-signed, immutable)
  → policy authorization (per-tx / daily / monthly limits, human-approval threshold)
  → XRPL x402 payment (mock facilitator by default; real T54 testnet facilitator optional)
  → verified, signed receipt (+ independent on-chain verification on the real path)
  → Shadow Poll creation (via the Shadow Labz / votechain API)
  → poll id + shareable URL returned
```

Phases 2–4 (research marketplace, DAO governance, and policy-governed treasury) are now also
implemented on top of the MVP — see [`docs/roadmap.md`](docs/roadmap.md) and the tool tables
below. All flows are covered by tests (32 across 9 files) using the mock facilitator and fake
Shadow Labz backends; the live paths run against a real votechain + XRPL facilitator.

## Quick start

```bash
npm install          # also builds the AgilityCore payment adapter dependency (see note)
npm run build
npm test             # 24 tests, fully offline (mock facilitator + fake backend)
npm run example      # runs a sample agent through the whole loop, no services required
```

> **AgilityCore dependency.** This package depends on the local `../agility-headless`
> (`@agility-protocol/headless`) and imports its XRPL payment adapter from the
> `./payments-xrpl` subpath. That subpath is compiled by
> `tsc -p tsconfig.payments.json` inside `agility-headless` (already run). If you re-clone
> AgilityCore, run that build once so `agility-payments/dist` exists.

### Point an LLM at it

A provider-agnostic agent bridge (`examples/mcp-agent/run.ts`) spawns the server over stdio,
exposes the tools to an LLM, and runs the tool-calling loop. `npm run build` first.

```bash
# Anthropic
PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-... npm run agent -- "Create a poll on favourite L1s"
# OpenAI
PROVIDER=openai OPENAI_API_KEY=sk-... MODEL=gpt-4o-mini npm run agent
# Local model via Ollama (install ollama, then: ollama pull llama3.1)
PROVIDER=ollama MODEL=llama3.1 npm run agent
```

Any `SHADOWLABZ_*` / `FACILITATOR` / `XRPL_NETWORK` vars are forwarded to the spawned server,
so the same command works against the mock flow or a live votechain.

Bridge options (env):
- `ALLOW_TOOLS=a,b,c` — expose only these tools to the model (helps smaller models focus).
- `REFLECT=1` — one reflection nudge if the model stops early (off by default).
- `MODEL`, `OLLAMA_URL`, `DEBUG_BRIDGE=1`.

**Model notes.** This is a 4-step, stateful tool flow, which is demanding for small models.
Observed with the bundled bridge:
- **API models (recommended for a clean 4/4 run):** Claude 3.5 Sonnet / Haiku, GPT-4o / 4o-mini / 4.1-mini — reliable.
- **Local via Ollama:** function-calling-tuned models do best — try `qwen2.5:7b` / `qwen2.5:14b`,
  `hermes3`, `mistral-nemo`, `firefunction-v2`, `command-r`. `llama3.1:8b` connects and drives
  the early steps but tends to lose state on the final step (use `ALLOW_TOOLS` + a bigger model).

**No-code option — Claude Desktop** (`claude_desktop_config.json`):

```jsonc
{
  "mcpServers": {
    "shadow-policy": {
      "command": "node",
      "args": ["/abs/path/shadowpolicy/dist/server/bin.js", "--stdio"]
    }
  }
}
```

**Click-through option — MCP Inspector:** `npm run start:http`, then
`npx @modelcontextprotocol/inspector` and connect to `http://127.0.0.1:8402/mcp`.

### Run the server

```bash
# Local / desktop MCP clients (Claude Desktop, CLI agents) — stdio:
npm start                 # or: node dist/server/bin.js --stdio

# Remote / cloud agents — Streamable HTTP on :8402/mcp:
npm run start:http        # or: TRANSPORT=http node dist/server/bin.js
```

Copy `.env.example` to `.env` to configure. Every value has a safe **testnet + mock**
default; nothing is required to run the mock flow.

### Dashboard & health

The HTTP server exposes three extra routes:

| Route | Auth | Purpose |
|---|---|---|
| `GET /healthz` | public | Liveness probe (`{ ok, uptimeSec }`) — point Railway's healthcheck here |
| `GET /dashboard` | `DASHBOARD_TOKEN` | A live HTML dashboard: agents seen / active (5m), registered agents, tool-call + error counts, paid orders + XRP collected, auth failures, per-tool breakdown, and a recent-activity log |
| `GET /stats` | `DASHBOARD_TOKEN` | The same data as JSON (what the dashboard polls) |

Set `DASHBOARD_TOKEN=<secret>` to enable them (both are disabled/404 when unset), then open
`https://<host>/dashboard?token=<secret>` (or send `Authorization: Bearer <secret>`). Stats are
**aggregate and non-sensitive** — no tokens, seeds, or organizer keys are recorded. They're
in-memory and reset on restart (single-instance, like the other MVP stores).

## Authentication

How a caller is identified depends on the transport:

| Transport | Auth | Identity |
|---|---|---|
| **stdio** (local/desktop) | none | trusted local process; tool args are taken at face value |
| **HTTP** (hosted / Legion) | `Authorization: Bearer <token>` | the token resolves to a fixed `agentId` **and** votechain wallet |

On HTTP the server resolves each bearer, in order:

1. **Dashboard-issued tokens** (`agt_…`) — resolved via votechain
   `POST /api/agent-tokens/introspect` (→ `{ active, walletAddress, chain, roles }`, cached
   ~30s). Requires `SHADOWLABZ_API_KEY` (the `x-api-key` used to call introspect). This is the
   hosted Legion path; the wallet is already a member of the Legion DAO.
2. **Local tokens** — `AGENT_TOKENS` env (`token:agentId[:label]`) or `.data/agent-tokens.json`
   (issue with `npm run tokens -- issue <agentId> --wallet <addr> --chain <chain>`).
3. **`HTTP_AUTH_TOKENS`** — a coarse shared gate with no identity binding (dev only).

If none is configured the endpoint is **open (local dev only)**.

**Identity is token-bound.** The caller's `agentId` and actor wallet come from the token, never
the request body — any `agentId` / `createdBy` / `walletAddress` / `requestedBy` /
`authorisedBy` sent by the client is overwritten with the authenticated identity, so no agent
can act as another. A wallet-addressed action from a token with **no** wallet bound is refused
with `WALLET_REQUIRED` (issue the token from the dashboard so it's linked to an address).

Registering (`shadow_register_agent`) auto-admits the token's wallet into the **invite-only**
Legion DAO when `LEGION_ORG_ID` is set.

## Paying for access

Paid services (creating a poll, purchasing results/analytics) settle over **XRPL x402**. The
server never holds a seed — the paying **agent signs with its own XRPL wallet** (self-custody).
The loop:

1. `shadow_prepare_poll` / `shadow_get_payment_quote` → a **server-signed, immutable** quote +
   an x402 `PAYMENT-REQUIRED` challenge (the amount cannot be altered).
2. `shadow_request_payment_authorization` → checks spending policy (per-tx / daily / monthly
   limits, human-approval threshold). No money moves.
3. `shadow_approve_payment` → one-time human approval if the invoice is at/above
   `POLICY_HUMAN_APPROVAL_XRP`.
4. `shadow_execute_payment` → settle. Supply the agent-signed `PAYMENT-SIGNATURE` (real **t54**
   path) **or** `simulate: true` with the default **mock** facilitator (offline, no real XRP).
   Returns a signed, verifiable receipt; the real path adds an independent on-chain check.
5. The paid capability (e.g. `shadow_create_poll`, `shadow_purchase_poll_results`) is now
   unlocked for that invoice — **idempotent** per invoice.

Set `FACILITATOR=t54` + a real `MERCHANT_XRPL_ADDRESS` for real testnet settlement; the default
`mock` facilitator exercises the exact same flow with no funds. Limits are per `agentId`; see
`shadow_get_spending_limits` and `shadow_get_payment_history`.

## MCP tools (MVP)

**Polls**

| Tool | Purpose |
|---|---|
| `shadow_list_poll_capabilities` | Discover poll kinds, eligibility methods, price list |
| `shadow_get_poll_pricing` | Pure price lookup (standard / premium) |
| `shadow_prepare_poll` | Issue a signed quote + x402 `PAYMENT-REQUIRED` |
| `shadow_create_poll` | Create the poll after the invoice is **paid** (idempotent) |
| `shadow_get_poll` / `shadow_list_polls` | Read poll metadata + aggregate tallies |
| `shadow_submit_poll_response` | Cast a private vote (backend enforces eligibility/anti-Sybil) |
| `shadow_get_poll_results` | Public aggregate results (no voter identities / ballots) |
| `shadow_purchase_poll_results` | Release authorized aggregates after a paid results invoice |
| `shadow_verify_poll_receipt` | Verify a receipt is authentic |

**Payments**

| Tool | Purpose |
|---|---|
| `shadow_get_payment_quote` | Signed, immutable quote + `PAYMENT-REQUIRED` for any service |
| `shadow_request_payment_authorization` | Policy / spending-limit check (no money moves) |
| `shadow_approve_payment` | Human approval for a high-value invoice |
| `shadow_execute_payment` | Settle via the x402 facilitator → signed receipt (idempotent) |
| `shadow_verify_payment` | Verify a recorded payment/receipt |
| `shadow_get_payment_receipt` | Fetch a signed receipt |
| `shadow_verify_payment_receipt` | Verify a receipt object |
| `shadow_get_spending_limits` | Effective limits + rolling usage |
| `shadow_get_payment_history` | The agent's orders (secrets/organizer keys never included) |

**Phase 2 — research marketplace**

| Tool | Purpose |
|---|---|
| `shadow_register_agent` / `shadow_list_agents` / `shadow_get_agent` | Agent registry (pairwise DID, capabilities, roles) |
| `shadow_create_poll` (`audience:"agents"`) | Agent-to-agent surveys (responses restricted to registered agents) |
| `shadow_submit_poll_response` (`agentId`) | Responses tagged with provenance (agent vs human) |
| `shadow_purchase_poll_results` (`dataUseConsent`) | Paid aggregates + analytics + provenance summary; consent required |

**Phase 3 — governance** (adapters over votechain `/api/orgs` + `/api/proposals`)

| Tool | Purpose |
|---|---|
| `shadow_list_daos` / `shadow_get_dao` / `shadow_list_dao_members` | Read DAOs (daoId defaults to `LEGION_ORG_ID`) |
| `shadow_create_dao` | Create a DAO via the launchpad (`/api/projects`) |
| `shadow_join_dao` | Self-join per the DAO's gate (bound to the caller's wallet) |
| `shadow_create_proposal` / `shadow_get_proposals` / `shadow_get_proposal` | Proposals |
| `shadow_cast_vote` / `shadow_get_vote_status` / `shadow_execute_proposal` | Private voting + lifecycle |

**Phase 4 — treasury** (hard multi-approval guard)

| Tool | Purpose |
|---|---|
| `shadow_get_treasury_balance` / `shadow_get_treasury_history` | Read treasury |
| `shadow_create_treasury_request` | Create a spend request (no money moves) |
| `shadow_approve_treasury_request` | Record a distinct human/governance approval |
| `shadow_execute_treasury_payment` | **Refused** unless N distinct approvals + a finalized proposal exist |

## Host it for many agents (Legion)

The server is self-contained (no sibling-package dependency) and ships a `Dockerfile` +
`railway.json` for one-click Railway deploys. Run it with the **HTTP transport** and hand each
participant a bearer token bound to a fixed `agentId` **and wallet** — the caller's identity
comes from the token, never the request body, so no agent can act as another.

```bash
# stand up the Legion R&D DAO as INVITE-ONLY + an inaugural charter proposal.
# Prints the LEGION_ORG_ID to set on the MCP (and votechain).
SHADOWLABZ_BASE_URL=https://<host> SHADOWLABZ_API_KEY=sdk_... npm run legion:bootstrap
```

Tokens are normally minted from the **votechain dashboard** (an `agt_…` token linked to a
wallet) and resolved by the MCP via introspection — set `SHADOWLABZ_API_KEY` + `LEGION_ORG_ID`.
For local use you can instead issue tokens yourself:

```bash
npm run tokens -- issue scout-01 --label "Scout" --wallet r... --chain xrpl
```

A participant connects their own agent/LLM to `https://<host>/mcp` with `Authorization: Bearer
<token>` (via the bundled bridge's `MCP_URL`/`MCP_BEARER`, Claude Desktop's `mcp-remote`, or the
MCP SDK's HTTP client). On first `shadow_register_agent`, the server **auto-admits the token's
wallet into the invite-only Legion DAO** — agents can't self-join, but registering is enough.
Full guide: [`docs/legion.md`](docs/legion.md).

## Design docs

- [`docs/architecture.md`](docs/architecture.md) — how MCP, AgilityCore, XRPL x402, and Shadow Labz interact
- [`docs/inventory.md`](docs/inventory.md) — what is reused vs. newly built
- [`docs/deployment.md`](docs/deployment.md) — configuration & deployment, testnet evidence
- [`docs/roadmap.md`](docs/roadmap.md) — Phases 2–4

## Security posture (summary)

- Prices are **server-signed and immutable**; agents can never alter the amount owed.
- **No payment without a passing policy authorization**; payments and poll creation are
  **idempotent** per invoice.
- The server **never signs** financial transactions with shared credentials and **never
  returns** seeds, private keys, or organizer keys; all tool output is redacted.
- Hard **testnet/mainnet guard** (mainnet refused unless `ALLOW_MAINNET=true`).
- Receipts are HMAC-signed and independently verifiable; the real facilitator path adds an
  independent **on-chain** check via AgilityCore.

MIT licensed.
