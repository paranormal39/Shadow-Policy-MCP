# Code inventory: reused vs. newly built

A core goal was to **reuse existing AgilityCore and Shadow Labz components** rather than
duplicate them. This records exactly what was reused, what was adapted, and what is new —
so the reuse claims are honest and verifiable.

## Reused as-is (imported)

| From | What | Used for |
|---|---|---|
| `@agility-protocol/headless/payments-xrpl` | `XrplPaymentAdapter`, `createPaymentRequest/Proof`, XRPL memo + drops helpers | Independent **on-chain verification** of a settled payment (`integrations/agilitycore`) |
| `@agility-protocol/headless` (main) | `sha256Hex`, `canonicalJson` | Canonical hashing for quote/receipt signatures (`security/hash`) |
| `@agility-protocol/headless` (main) | `derivePairwiseDid` | Per-service **pairwise DID** for each agent identity (`integrations/agilitycore`) |
| Shadow Labz / votechain | `POST /api/polls`, `GET /api/polls/{id}`, `GET /api/polls`, `POST /api/polls/{id}/vote` | The Shadow Polls adapter (`integrations/shadowlabz`) |
| votechain `x-api-key` gate | `GAME_API_KEY` / `sdk_` per-client keys | Machine auth for the poll adapter |

## Adapted / packaged (small edits to AgilityCore)

| Change | Why |
|---|---|
| Added `agility-headless/tsconfig.payments.json` and built `agility-payments/{core,xrpl}` → `agility-payments/dist` | The payment module lived outside `src/` and was never compiled into `dist`; it is now importable. Built with `noEmitOnError:false` because the adapter has type friction with the installed `xrpl` v4 (`dropsToXrp` returns a number there) — runtime logic is correct and amount normalisation is redone in our wrapper. |
| Added `./payments-xrpl` and `./payments-core` export subpaths to `agility-headless/package.json` | Expose exactly the reused surface. |

## Newly built (not present in AgilityCore / Shadow Labz)

AgilityCore's `src/core` managers (`IdentityManager`, `StateManager`, ...) are shaped for a
single-user **device SDK** (one identity, heavy constructor deps), not a multi-agent server.
Per the project brief ("design small extensible interfaces" for missing capabilities), these
server-side pieces are new and local:

| Module | Responsibility |
|---|---|
| `services/pricing` | Server-signed, immutable quotes; configurable fee table |
| `services/authorization` | Spending-limit **policy engine** (per-tx / daily / monthly / destinations / human-approval) |
| `services/orders` | Order lifecycle + idempotency anchor |
| `services/receipts` | HMAC-signed, verifiable receipts |
| `services/operations` | Orchestration enforcing all invariants |
| `integrations/xrpl` | **x402 v2** types + header codec, `PaymentFacilitator` interface, `MockFacilitator`, `T54XrplFacilitator` |
| `security/*` | BigInt money, idempotency store, secret redaction, HMAC signing |
| `server/*`, `tools/*`, `schemas/*`, `config/*` | MCP server, tool registry, zod schemas, env config |

## Deliberately deferred

`tools/daos`, `tools/governance`, `tools/treasury` exist as **empty registries** with notes.
The research marketplace, DAOs, governance, and treasury flows are specified in
`docs/roadmap.md` and not implemented in the MVP.
