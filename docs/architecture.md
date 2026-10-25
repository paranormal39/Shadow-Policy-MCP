# Architecture

Shadow Policy MCP sits between AI agents and the Shadow Labz governance backend, adding a
policy-enforced, pay-per-use layer on top of existing APIs.

```
            ┌──────────────────────────────────────────────────────────────┐
            │                      AI AGENT (MCP client)                     │
            │   Claude Desktop · local LLM agent · Bedrock AgentCore · ...   │
            └───────────────┬──────────────────────────────────────────────┘
                            │  MCP (stdio or Streamable HTTP)
            ┌───────────────▼──────────────────────────────────────────────┐
            │                     SHADOW POLICY MCP SERVER                   │
            │                                                                │
            │  server/           tool registry, transports, DI context      │
            │  tools/polls       MVP poll tools                              │
            │  tools/payments    MVP payment tools                           │
            │  tools/{daos,governance,treasury}  future (empty)             │
            │                                                                │
            │  services/pricing        signed, immutable quotes              │
            │  services/authorization  spending-limit policy engine          │
            │  services/orders         quote→authorized→paid→fulfilled       │
            │  services/receipts       HMAC-signed receipts                  │
            │  services/operations     orchestration (idempotent)            │
            │                                                                │
            │  security/   money(BigInt) · idempotency · redaction · hash    │
            └───────┬───────────────────────┬───────────────────┬───────────┘
                    │                        │                   │
        ┌───────────▼─────────┐  ┌───────────▼────────┐  ┌───────▼─────────────────┐
        │   x402 facilitator  │  │    AgilityCore      │  │   Shadow Labz (votechain)│
        │  (integrations/xrpl)│  │ (@agility-protocol/ │  │ (integrations/shadowlabz)│
        │                     │  │   headless)         │  │                          │
        │ PaymentFacilitator  │  │ XrplPaymentAdapter  │  │  POST /api/polls         │
        │  ├ MockFacilitator  │  │  → on-chain verify  │  │  GET  /api/polls/{id}    │
        │  └ T54XrplFacilitator│  │ derivePairwiseDid  │  │  POST /api/polls/{id}/vote│
        │    → XRPL testnet    │  │ sha256/canonicalJson│  │  (x-api-key auth)        │
        └─────────┬───────────┘  └─────────────────────┘  └──────────────────────────┘
                  │
            ┌─────▼──────────────┐
            │     XRP Ledger     │
            │  (testnet default) │
            └────────────────────┘
```

## The MVP transaction flow

1. **Discover** — `shadow_list_poll_capabilities` returns kinds, eligibility methods, and
   the price list (all prices come from config, denominated in XRP drops).
2. **Quote** — `shadow_prepare_poll` / `shadow_get_payment_quote` mint a `Quote`:
   immutable core fields (amount, destination, invoiceId, resource) + an HMAC `signature`.
   The quote is wrapped into an x402 `PAYMENT-REQUIRED` challenge (and the base64 header).
   An `Order` is opened, keyed by `invoiceId`.
3. **Authorize** — `shadow_request_payment_authorization` runs the `PolicyEngine`:
   destination allow-list, per-tx / rolling daily / rolling monthly limits, and a
   human-approval threshold. Nothing moves money.
4. **Pay** — `shadow_execute_payment` builds the x402 `X402Accepted` requirements from the
   quote and hands the agent's signed `PaymentPayload` to the facilitator's `settle()`.
   - *Mock* (default): deterministic, offline; the "signed blob" is a mock envelope.
   - *T54* (optional): posts to the hosted XRPL facilitator's `/verify` + `/settle`; the
     settled tx is then independently re-verified on-chain via AgilityCore's adapter.
   The spend is recorded against the agent's allowances and a signed `Receipt` is issued.
   The whole step is wrapped in `idempotency.once("pay:<invoiceId>")`.
5. **Create** — `shadow_create_poll` checks the order is *paid* and calls the Shadow Labz
   `POST /api/polls`. The returned one-time `organizerKey` is **retained server-side** in the
   order and never surfaced; the agent gets the poll id + `${SHADOWLABZ_PUBLIC_URL}/polls/{id}`.
   Wrapped in `idempotency.once("poll:<invoiceId>")`, so retries return the same poll.

## Why these boundaries

- **Paywall in the MCP server, not votechain.** votechain's `POST /api/polls` stays free and
  public; Shadow Policy holds the `x-api-key` and gates creation behind payment + policy. This
  keeps the integration modular and lets the same backend serve both paid (agent) and free
  (human) creation paths.
- **Facilitator interface.** Settlement is abstracted so the default build is fully offline
  and testable, while a real XRPL testnet/mainnet facilitator slots in via config with no
  code change in the tools or services.
- **Money as BigInt drops.** All amounts are integer drops; no floating-point math on money.
