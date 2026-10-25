# Deployment & configuration

## Configuration

All config comes from the environment (validated in `src/config`). Copy `.env.example` to
`.env`. Defaults are **testnet + mock facilitator** so the server runs with zero setup.

Key variables:

| Variable | Default | Notes |
|---|---|---|
| `XRPL_NETWORK` | `testnet` | `testnet` / `devnet` / `mainnet` |
| `ALLOW_MAINNET` | `false` | Must be exactly `true` to run on mainnet (hard guard) |
| `TRANSPORT` | `stdio` | `stdio` or `http` |
| `HTTP_PORT` | `8402` | HTTP transport port (`/mcp`) |
| `HTTP_AUTH_TOKENS` | _(empty)_ | Comma-separated bearer tokens; empty = auth disabled |
| `FACILITATOR` | `mock` | `mock` (offline) or `t54` (real hosted XRPL facilitator) |
| `T54_FACILITATOR_URL` | per-network | Override the facilitator base URL |
| `MERCHANT_XRPL_ADDRESS` | mock placeholder | **Required** for `t54`; where payments are collected |
| `SHADOWLABZ_BASE_URL` | `http://localhost:3000` | votechain backend |
| `SHADOWLABZ_PUBLIC_URL` | = base URL | Used to build shareable poll URLs |
| `SHADOWLABZ_API_KEY` | _(none)_ | `x-api-key`; optional while votechain's gate is disarmed |
| `RECEIPT_SIGNING_SECRET` | ephemeral | Set a stable value in production |
| `PRICE_*_XRP`, `POLICY_*_XRP` | see `.env.example` | Pricing & spending policy |

## Running

```bash
npm run build
node dist/server/bin.js            # stdio
TRANSPORT=http node dist/server/bin.js   # http on :8402/mcp
```

### Claude Desktop (stdio) example

```jsonc
{
  "mcpServers": {
    "shadow-policy": {
      "command": "node",
      "args": ["/abs/path/shadowpolicy/dist/server/bin.js", "--stdio"],
      "env": { "SHADOWLABZ_BASE_URL": "http://localhost:3000", "SHADOWLABZ_API_KEY": "sdk_..." }
    }
  }
}
```

## Issuing a Shadow Labz API key

The poll adapter authenticates to votechain with `x-api-key`. Issue a per-client key from the
votechain repo (see its `API.md`):

```bash
npm run scripts:api-keys -- create "Shadow Policy MCP" --note "x402 poll agent"
# → sdk_<id>.<secret>  (shown once) → set as SHADOWLABZ_API_KEY
```

## Testnet evidence (real x402 path)

The default tests use the mock facilitator and are hermetic. To exercise the **real** path:

1. Set `FACILITATOR=t54`, `XRPL_NETWORK=testnet`, and a real funded testnet
   `MERCHANT_XRPL_ADDRESS`.
2. The paying agent constructs and signs an XRPL Payment for the quoted amount to `payTo`,
   encodes it as the x402 `PAYMENT-SIGNATURE` header, and passes it to
   `shadow_execute_payment` (the server never signs).
3. `settle()` posts to `${T54_FACILITATOR_URL}/settle`; on success the tx is independently
   re-verified on-chain (AgilityCore `XrplPaymentAdapter`) before the receipt is issued.
4. Capture the resulting `receipt.txHash` and look it up on a testnet explorer as evidence.

> This path requires network access and funded testnet wallets; it is intentionally kept
> separate from the tested, offline mock path.

## Production checklist

- [ ] Set a stable `RECEIPT_SIGNING_SECRET`.
- [ ] Replace the in-memory `OrderStore` / `PolicyEngine` / idempotency store with a durable
      backend (the interfaces are isolated for this).
- [ ] Put the HTTP transport behind TLS and set `HTTP_AUTH_TOKENS`.
- [ ] Keep `ALLOW_MAINNET` unset unless you intend real-money settlement.
