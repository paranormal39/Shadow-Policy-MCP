# Shadow DAOs / VoteChain HTTP API

Reference for every route under `/api/*`, the authentication models they use,
and how to issue an API key to an external integrator (game studio, bot,
partner tool).

- [Conventions](#conventions)
- [Authentication models](#authentication-models)
- [Issuing an API key to someone](#issuing-an-api-key-to-someone)
- [Endpoint reference](#endpoint-reference)
  - [Health & platform metadata](#health--platform-metadata)
  - [Stats, leaderboard, calendar](#stats-leaderboard-calendar)
  - [Auth & sessions](#auth--sessions)
  - [Wallets](#wallets)
  - [Public chain lookups](#public-chain-lookups)
  - [Organizations (DAOs)](#organizations-daos)
  - [Proposals & voting](#proposals--voting)
  - [Launchpad projects](#launchpad-projects)
  - [Shadow Polls](#shadow-polls)
  - [Inbox & profile](#inbox--profile)
  - [Subscription / billing](#subscription--billing)
  - [Contact](#contact)
  - [Webhooks](#webhooks)
  - [Internal](#internal)

---

## Conventions

**Base URL** — the public host the app is served from (`APP_PUBLIC_URL`,
e.g. `https://print-marine-litmus.ngrok-free.dev` in dev, `http://localhost:3000`
locally). All paths below are relative to it.

**Content type** — request bodies are JSON (`Content-Type: application/json`).

**Response envelope** — every JSON route returns:

```jsonc
// success
{ "success": true, "data": { ... } }

// failure
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "…", "details": { ... } } }
```

(Exceptions: the Discord/PayPal/Xaman webhooks and OAuth redirects return
whatever their callers require.)

**Common status / error codes**

| Status | `error.code` | Meaning |
|---|---|---|
| 400 | `INVALID_JSON`, `MISSING_PARAM`, `ADDRESS_REQUIRED`, … | Malformed body or missing query parameter |
| 401 | `UNAUTHORIZED` | `x-api-key` missing/invalid on an API-key-gated route |
| 401 | `SESSION_REQUIRED` | Wallet session cookie required |
| 403 | `SESSION_WALLET_MISMATCH` | Session wallet ≠ the wallet named in the body |
| 403 | `NOT_ADMIN`, `PROPOSAL_FORBIDDEN`, `PROJECT_FORBIDDEN`, `EVENT_FORBIDDEN`, `ORG_PRIVATE` | Caller lacks the role for this action |
| 402 / 403 | `TIER_REQUIRED`, `TIER2_REQUIRED`, `TIER3_REQUIRED`, `DAO_LIMIT_REACHED` | Subscription tier gate (only when PayPal billing is configured) |
| 404 | `ORG_NOT_FOUND`, `PROPOSAL_NOT_FOUND`, `PROJECT_NOT_FOUND`, `POLL_NOT_FOUND`, … | Resource missing |
| 409 | `ALREADY_VOTED`, `DUPLICATE_MEMBER`, `PROPOSAL_STATE`, `PROJECT_STATE`, `TREASURY_STATE`, `EVENT_LIMIT`, `WATCH_LIMIT` | State conflict |
| 410 | `CHALLENGE_EXPIRED`, `SESSION_EXPIRED` | One-time challenge no longer valid |
| 422 | `VALIDATION_ERROR` (+ zod `details`), `PROOF_INVALID`, `INVALID_ADDRESS` | Body failed schema validation |
| 429 | `RATE_LIMITED` | Per-IP rate limit for that route exceeded |
| 503 | `MAINTENANCE` | Treasury routes while `NEXT_PUBLIC_TREASURY_MAINTENANCE` ≠ `off` |
| 500 | `INTERNAL_ERROR` | Unhandled failure |

**CORS** — browsers on other origins can call `/api/*` only if the origin is
listed in `GAME_ALLOWED_ORIGINS` (comma-separated, or `*`). Allowed headers
are `Content-Type` and `x-api-key`. Native/server clients are unaffected.

**Chains** — wherever a `chain` field appears it is one of
`midnight | xrpl | xahau | cardano`.

---

## Authentication models

Routes use one (sometimes two) of these. The reference tables below tag each
route with the model it uses.

| Tag | How it works |
|---|---|
| **Public** | No credentials. |
| **Session** | A wallet session cookie, established by the browser through `/api/auth/*` (CIP-30 / Midnight signData / Xaman / passkey / OAuth). When the body names a wallet (e.g. `walletAddress`, `createdBy`, `requester`) it must equal the session wallet → otherwise `403 SESSION_WALLET_MISMATCH`. |
| **API key** | Header `x-api-key: <key>`. Accepted keys are the legacy shared `GAME_API_KEY` **or** any active per-client key issued with the CLI (see next section). A valid API key **also satisfies Session** on routes tagged `Session`: the caller is treated as a trusted integration and the body's wallet is taken at face value. Same-origin browser requests (the web app itself) pass the API-key gate automatically. If no key has ever been configured/issued, the gate is disabled entirely (dev default). |
| **Organizer key** | Shadow Polls only. `POST /api/polls` returns a one-time `organizerKey`; host actions accept it in the JSON body (`{"organizerKey": "…"}`) **or** a Session matching the poll's creator. |
| **Internal secret** | Header `x-internal-secret: $BOT_INTERNAL_SECRET` for `/api/internal/*`. |
| **Signed webhook** | Provider-signed payloads: Discord (Ed25519, `DISCORD_PUBLIC_KEY`), PayPal (`PAYPAL_WEBHOOK_ID` verify API). The Xaman webhook is unsigned but re-fetches the payload from Xaman before trusting it. |

> **Trust note for API-key holders.** Because an API key bypasses the wallet
> session check, a key holder can act *as any wallet address* on `Session`
> routes (create proposals as X, vote as Y, …). Only issue keys to
> integrations you'd trust with that power, and revoke on offboarding.

---

## Issuing an API key to someone

Per-client keys live in `lib/api-keys/`. Each key is a random
`sdk_<12-hex-id>.<secret>` string; only its SHA-256 hash is stored
(`.data/api-keys.json` locally, the Postgres `app_documents` store when
`DATABASE_URL` is set). Keys are named, listable and revocable.

Run these from the repo root **against the same `.env` / database the app
uses** (the CLI reads `.env` via `lib/load-env`):

```bash
# 1. Create a key for the integrator. The plaintext is printed ONCE.
npm run scripts:api-keys -- create "Partner Game Studio" --note "contact: dev@partner.io"

#   Issued API key for "Partner Game Studio" (sdk_ab12cd34ef56)
#
#     sdk_ab12cd34ef56.Mzqzfw8p1OLZAUAS_FGPOzHWAU2rJ0-eqEoAbFNuVB0
#
#   Copy it now — it cannot be shown again.

# 2. See what's issued (never shows secrets).
npm run scripts:api-keys -- list

# 3. Revoke when the integration is retired or the key leaks.
npm run scripts:api-keys -- revoke sdk_ab12cd34ef56
```

Hand the key to the recipient over a secure channel (password manager share,
not chat/email). They send it on every request:

```bash
curl -X POST "$BASE/api/orgs/<orgId>/proposals" \
  -H "Content-Type: application/json" \
  -H "x-api-key: sdk_ab12cd34ef56.Mzqzfw8p1OLZAUAS_FGPOzHWAU2rJ0-eqEoAbFNuVB0" \
  -d '{"title":"Fund season 2","description":"…","votingPeriodDays":7,"createdBy":"addr1…"}'
```

Operational notes:

- **Gate semantics.** The `x-api-key` gate is *off* until either
  `GAME_API_KEY` is set or the first client key is issued. From then on it
  stays on — revoking the last key does **not** reopen the write API.
- **Propagation.** Verification uses a 30-second in-process cache, so a
  revoke is effective immediately on the instance that ran it and within
  30 s elsewhere. Restarting the app clears the cache.
- **Rotation.** Create the new key, ship it, then revoke the old one; both
  are valid in the overlap.
- **Legacy `GAME_API_KEY`.** Still honoured as a single shared master key
  (set in `.env`). Prefer per-client keys for anything you hand to a third
  party so you can revoke individually.
- **Scopes.** All keys currently carry the same permissions (full
  integration write access). The record shape (`lib/api-keys/record.ts`)
  leaves room for scopes/last-used tracking if needed later.
- **Cross-origin browsers.** If the integrator calls from a browser on
  another origin, also add that origin to `GAME_ALLOWED_ORIGINS`.

---

## Endpoint reference

Columns: **Auth** uses the tags above. **Rate** is the per-IP limit where one
exists. Bodies are summarised from the zod schemas in each route /
`lib/domain/schemas.ts`; unlisted fields are optional.

### Health & platform metadata

| Method & path | Auth | Description |
|---|---|---|
| `GET /api/health` | Public | AgilityCore upstream health passthrough. |
| `GET /api/health/midnight` | Public | Midnight connectivity diagnostics: indexer HTTP/WS, proof server(s), server wallet snapshot, which Shadow Polls contracts are wired. `200` when healthy, `503` otherwise. Secrets redacted. |
| `GET /api/networks` | Public | Which network each chain (xrpl, xahau, cardano, midnight) is configured for — labels only. |
| `GET /api/wallet/server-status` | Public | Non-blocking snapshot of the server's Midnight wallet: sync state, balance, `dustCoins`, `dustCoinValues`, `dustLanes.waiting`. |
| `GET /api/metrics/chain-timing` | Public | Rolling average durations per on-chain interaction kind. |
| `POST /api/metrics/chain-timing` | Public · 60/min | Record one timing. Body `{ kind: <CHAIN_OP_KIND>, ms: 0..600000 }`. |

### Stats, leaderboard, calendar

| Method & path | Auth | Description |
|---|---|---|
| `GET /api/stats` | Public | Platform-wide metrics for the landing page. |
| `GET /api/stats/wallet?address=` | Public | Per-wallet activity counts (proposals, votes, orgs). |
| `POST /api/stats/connect` | API key · 30/min | Record a wallet connection for traction metrics. Body `{ address, chain, source? }`. |
| `GET /api/stats/activity?address=` | Public · Tier 2 | XP / level / rank breakdown for a wallet. |
| `GET /api/leaderboard?address=&board=wallets\|daos&limit=1..50` | Public · Tier 2 | Activity leaderboards. Wallet rows carry aliases/pseudonyms only. |
| `GET /api/orgs/ranks` | Public | `orgId → { rank, level, xp }` for public DAOs. |
| `GET /api/calendar?address=&from=&to=` | Public · Tier 1 | Aggregate calendar across the wallet's DAOs (voting deadlines, events, funding deadlines). `from`/`to` ISO, default current month. |
| `GET /api/orgs/{id}/calendar?address=&from=&to=` | Public · Tier 1 | Same, for one DAO. Private DAOs: members only (`403 ORG_PRIVATE`). |

### Auth & sessions

These install/clear the **wallet session cookie** used by `Session` routes.
Browser flows; API-key integrations don't need them.

| Method & path | Auth | Description |
|---|---|---|
| `GET /api/auth/session` | Public | Current session `{ address, chain, method }` or `null`. |
| `DELETE /api/auth/session` | Public | Log out (clears cookie). |
| `GET /api/auth/providers` | Public | Which Web2 providers are configured: `{ google, discord, passkey }`. |
| `POST /api/auth/challenge` | Public · 10/min | Start a wallet sign-in. Body `{ walletAddress, chain, method?: 'signdata' }`. Cardano / Midnight-signData → returns `{ challenge, method, message }` to sign; other chains → attested session cookie set immediately. |
| `POST /api/auth/verify` | Public · 10/min | Complete the challenge. Body `{ challenge, signature, key? (CIP-30 COSE_Key), verifyingKey?, signedData? (Midnight) }`. Sets the session cookie. Errors `410 CHALLENGE_EXPIRED`, `422 PROOF_INVALID`, `403 WALLET_MISMATCH`. |
| `POST /api/auth/passkey/register-options` | Public · 10/min | WebAuthn registration options (adds a passkey to the signed-in Web2 account if any, else starts a new account). Challenge in a signed cookie. |
| `POST /api/auth/passkey/register` | Public · 10/min | Body = WebAuthn attestation response. Creates account + generated Midnight wallet, sets session. |
| `POST /api/auth/passkey/login-options` | Public · 20/min | WebAuthn authentication options (discoverable credentials). |
| `POST /api/auth/passkey/login` | Public · 20/min | Body = WebAuthn assertion. Sets session. `404 UNKNOWN_CREDENTIAL`. |
| `GET /api/auth/google/start` · `GET /api/auth/discord/start` | Public | Redirect to the provider's consent screen. |
| `GET /api/auth/google/callback` · `GET /api/auth/discord/callback` | Public | OAuth callback: mints/links the generated-wallet account and sets the session. Redirect URI must be registered with the provider. |
| `POST /api/auth/account/seed` | Session (Web2 methods only) · 5/15 min | Export the account's generated Midnight seed. Requires a fresh passkey assertion (`{ assertion }`) when the account has passkeys, else `{ confirm: true }`. Response is `no-store`; audit-logged. |

### Wallets

| Method & path | Auth | Description |
|---|---|---|
| `POST /api/wallet/generate` | API key · 10/min | Generate an ephemeral test identity. Body `{ chain }`. Returns `{ address, chain, network }` only. |
| `POST /api/wallet/xaman` | Public | Create a Xaman SignIn payload. Body `{ type: 'SignIn' }`. `503 XAMAN_NOT_CONFIGURED` without keys. |
| `GET /api/wallet/xaman?uuid=` | Public | Poll a payload; when signed, sets an `xrpl`/`xahau` session cookie. |
| `GET /api/wallet/cardano/challenge?session=` | Public | Message to sign for a Discord `/link-cardano` session. `410 SESSION_EXPIRED`. |
| `POST /api/wallet/cardano/verify` | Public | Body `{ session, signature, key }`. Verifies CIP-30 proof, enrols the wallet in the DAO, posts a Discord follow-up. Wallet address is never echoed. |

### Public chain lookups

| Method & path | Auth | Description |
|---|---|---|
| `GET /api/treasury/cardano?address=addr1…` | Public | Read-only snapshot of any Cardano address (ADA, tokens, NFTs, recent in/outflows). |
| `GET /api/treasury/xrpl?address=r…&network=mainnet\|chain` | Public | Same for XRPL. |

### Organizations (DAOs)

Orgs are created automatically when a launchpad project activates — see
[Launchpad projects](#launchpad-projects).

| Method & path | Auth | Description |
|---|---|---|
| `GET /api/orgs?all=1` | Public | List DAOs. Default hides orgs without a deployed ShadowDAO contract; `all=1` lists everything. |
| `POST /api/orgs` | — | Always `409 ORG_CREATE_DISABLED` (use `POST /api/projects`). |
| `GET /api/orgs/{id}` | Public | Org detail incl. members, settings, governance, subGate. |
| `PATCH /api/orgs/{id}` | API key + Session (org admin) | Update membership settings and/or profile. Body: any of `membership { joinPolicy: invite\|open\|gated, requirements[] }`, `description`, `avatarUrl`, `socials{website,twitter,discord,github}`, `tags[]`, `treasuryGoal`, `accentColor`, `visibility: public\|private`, `governance { votingMode: equal\|weighted, asset?, proposalPolicy?: admins\|members, quorumPercent? }`. |
| `GET /api/orgs/{id}/members` | Public | Member list. |
| `POST /api/orgs/{id}/members` | API key + Session (org admin) | Body `{ walletAddress, chain, displayName?, role?: admin\|member\|observer }`. With a **session** this sends an inbox *invitation*; with an **API key only** it directly enrols (legacy integration path). |
| `PATCH /api/orgs/{id}/members/{wallet}` | API key + Session (org admin) | Body `{ role }`. |
| `DELETE /api/orgs/{id}/members/{wallet}` | API key + Session (org admin) | Remove a member. |
| `POST /api/orgs/{id}/invites` | Session (org admin) · 30/hour | Body `{ walletAddress }` **or** `{ inviteRef }` (opaque leaderboard ref), `note?`. API-key-only callers get `401 SESSION_REQUIRED`. |
| `POST /api/orgs/{id}/join` | API key + Session (wallet = `walletAddress`) · 20/min | Self-join per the org's join policy. Body `{ walletAddress, chain, displayName?, proofHash? }`. `403 MEMBERSHIP_DENIED` with requirement results. |
| `GET /api/orgs/{id}/proposals` | Public | Proposals for the org. |
| `POST /api/orgs/{id}/proposals` | API key + Session (wallet = `createdBy`) | Body `{ title, description, type?: general\|treasury, votingPeriodDays? (1..90) \| votingPeriodHours? (1..2160), quorumWeightPercent?, createdBy }`. `201`. |
| `GET /api/orgs/{id}/analytics?address=` | Public · Tier 2 | Aggregate governance / membership / delegation / treasury analytics. Private orgs: members only. |
| `POST /api/orgs/{id}/events` | API key · Tier 1 | Create a calendar event. Body `{ walletAddress, title, description?, kind?: voice\|meeting\|other, startsAt (ISO), endsAt?, link?, recurrence?: { freq: daily\|weekly\|biweekly\|monthly, until? } }`. Permission follows the org's `proposalPolicy`. |
| `PATCH /api/orgs/{id}/events/{eventId}` | API key | Body `{ walletAddress, …fields }`; `null` clears an optional field. Creator or admin. |
| `DELETE /api/orgs/{id}/events/{eventId}` | API key | Body `{ walletAddress }`. |
| `GET /api/orgs/{id}/feedback` | Public | Anonymous member feedback list. |
| `POST /api/orgs/{id}/feedback` | API key + Session (wallet = `walletAddress`) | Body `{ walletAddress, body, period? }`. `201`. |
| `GET /api/orgs/{id}/delegations` | Public | All delegations. |
| `POST /api/orgs/{id}/delegations` | API key + Session (wallet = `delegatorAddress`) | Body `{ delegatorAddress, delegateAddress }`. `201`. |
| `DELETE /api/orgs/{id}/delegations` | API key + Session (wallet = `delegatorAddress`) | Body `{ delegatorAddress }`. |
| `GET /api/orgs/{id}/delegations/profile/{addr}` | Public | Delegate profile for a wallet. |
| `GET /api/orgs/{id}/onchain` | Public | Verify the org's ShadowDAO contract on Midnight: `{ address, deployed, verified, state, provisioning? }`. Re-kicks provisioning if missing. |
| `GET /api/orgs/{id}/wallet` | Public | The DAO's Midnight custody deposit address (`mn_addr_…`), created on first call. Midnight orgs only. |
| `GET /api/orgs/{id}/subgate?wallet=` | Public | Paid-membership gate config, PayPal client id/env, revenue split, earnings, and the wallet's status. |
| `POST /api/orgs/{id}/subgate` | API key · admin · Tier 2 | Body `{ requester, config: { enabled, priceUsd, organizerFeeBps, organizerPayoutEmail } }`. Provisions the per-DAO PayPal plan. |
| `POST /api/orgs/{id}/subgate/confirm` | API key · 10/min | Finalize a member's paid checkout. Body `{ walletAddress, chain, subscriptionId }`; re-fetched from PayPal before enrolling. |
| `POST /api/orgs/{id}/crowdfunding` | API key + Session (wallet = `requester`) · admin · Tier 2 | Start a 2-week crowdfunding round. Body `{ requester, goalAmount }`. Returns `{ project, depositAddress, windowDays, deadline }`. Treasury-maintenance gated. |

**Treasury** (all `503 MAINTENANCE` while `NEXT_PUBLIC_TREASURY_MAINTENANCE` ≠ `off`, except the bypass wallet):

| Method & path | Auth | Description |
|---|---|---|
| `GET /api/orgs/{id}/treasury` | Public | Get or initialise the ledger treasury account. |
| `POST /api/orgs/{id}/treasury` | API key + Session (wallet = `initiatorAddress`) · Tier 2 | Record a deposit. Body `{ amount, currency?, initiatorAddress, memo?, txHash? }`. `201`. |
| `POST /api/orgs/{id}/treasury/spend` | API key + Session (wallet = `requestedBy`) · Tier 2 | Create a spend request. Body `{ amount, currency?, recipientAddress, purpose, privacyMode?: public\|hybrid\|private, requestedBy, proposalId? }`. `201`. |
| `POST /api/orgs/{id}/treasury/spend?action=execute` | API key + Session (wallet = `authorisedBy`) · Tier 2 | Body `{ spendRequestId, authorisedBy, txHash? }`. Audit-logged. |
| `POST /api/orgs/{id}/treasury/spend?action=link` | API key + Session | Body `{ spendRequestId, proposalId }`. |
| `DELETE /api/orgs/{id}/treasury/spend?spendRequestId=&by=` | API key + Session (wallet = `by`) · Tier 2 | Cancel a pending spend request. |
| `GET /api/orgs/{id}/treasury/watch` | Public | Saved watch-only addresses. |
| `POST /api/orgs/{id}/treasury/watch` | API key + Session (wallet = `requester`) · admin | Body `{ requester, chain: xrpl\|cardano, address, label? }`. `201`, `409 WATCH_LIMIT`. |
| `DELETE /api/orgs/{id}/treasury/watch?id=&by=` | API key + Session (wallet = `by`) · admin | Remove a watch address. |
| `GET /api/orgs/{id}/treasury/multichain` | Public | Multichain treasury addresses + live balances (`null` until opened). |
| `POST /api/orgs/{id}/treasury/multichain` | API key + Session (wallet = `requester`) · admin · Tier 3 | Open XRPL + Cardano + Midnight treasury addresses. Body `{ requester, xrplAddress?, cardanoAddress? }` (import your own, address only). Freshly generated secrets come back **once** in `oneTimeSecrets` (`no-store`). |
| `POST /api/orgs/{id}/wallet/seed` | Session (wallet = `requester`) · admin · 5/15 min | Reveal treasury wallet secrets. Body `{ requester, revealSecret }` where `revealSecret` = server `SEED_REVEAL_SECRET`. `503 REVEAL_DISABLED` when unset. Audit-logged, `no-store`. |
| `DELETE /api/orgs/{id}/wallet/seed` | Session (wallet = `requester`) · admin · 5/15 min | Purge legacy encrypted XRPL/Cardano treasury secrets (irreversible). Same body/gate as the reveal. |

### Proposals & voting

| Method & path | Auth | Description |
|---|---|---|
| `GET /api/proposals/active?address=` | Public | Active proposals across every DAO the wallet belongs to. |
| `GET /api/proposals/{pid}` | Public | Proposal detail (aggregate tally only — never per-voter choices). |
| `POST /api/proposals/{pid}/vote` | API key + Session (wallet = `walletAddress`) · 30/min | Cast a private vote. Body `{ walletAddress, choice: yes\|no\|abstain }`. `409 ALREADY_VOTED`. |
| `POST /api/proposals/{pid}/status` | API key + Session (any wallet) | Body `{ action: activate\|finalize }`. `409 PROPOSAL_STATE`. |
| `GET /api/proposals/{pid}/comments` | Public | Comments. |
| `POST /api/proposals/{pid}/comments` | API key + Session (wallet = `author`) | Body `{ author, body }`. `201`. |

### Launchpad projects

A project is the funding/launch record that becomes a DAO (org) on activation.

| Method & path | Auth | Description |
|---|---|---|
| `GET /api/projects` | Public | All projects (public view). |
| `POST /api/projects` | API key + Session (wallet = `createdBy`) | Create a DAO project. Body `{ name, description?, avatarUrl?, socials?, accentColor?, tags?, chain, createdBy, goalAmount?, currency, deadline?, visibility?, membership: { kind: token\|nft\|credential, name, currency?, amountPerContributor?, taxon? } }`. Tier caps: `403 DAO_LIMIT_REACHED`; `goalAmount > 0` needs Tier 2. `201`. |
| `GET /api/projects/{id}` | Public | Project detail. |
| `DELETE /api/projects/{id}?requester=` | API key + Session (wallet = `requester`) | Creator-only delete; blocked while refundable funds remain (`409 PROJECT_STATE`). |
| `POST /api/projects/{id}/status` | API key + Session (any wallet) | Drive the lifecycle. Body `{ action: open\|sync\|verify-fee\|activate\|fail\|refund }`. |
| `GET /api/projects/{id}/contribute` | Public | Deposit instructions: `{ chain, currency, escrowAddress, memo, goalAmount, raisedAmount, deadline, launchFee, launchFeePaid, awaitingLaunchFee }`. `409 PROJECT_STATE` when not open. |
| `GET /api/projects/{id}/contributions` | Public | Contribution list. |
| `GET /api/projects/{id}/bot` | Public | Discord bot status for the project: treasury tier, `inviteUrl`, bound `guildId`. |
| `DELETE /api/projects/{id}/bot` | API key + Session | Unbind the project's Discord guild. |

### Shadow Polls

Standalone private polls/surveys. Host actions accept the **Organizer key**
(`{"organizerKey": "…"}` in the body) or the creator's Session. Voter
identity is the Session wallet or an anonymous `deviceId` (16–64 hex chars)
held client-side. On-chain mode means create/activate/close/vote run a ZK
proof and can take minutes.

| Method & path | Auth | Description |
|---|---|---|
| `GET /api/polls` | Public | All polls, newest first (metadata + tallies). |
| `POST /api/polls` | Public · 10/min | Create a draft. Body `{ title, description?, kind: single\|survey, options? (2..8), questions? [{ prompt, options (2..6), type?: single\|multi\|stars }] (1..6), segments? (2..16), eligibility: { method: open\|qr_rotating\|token\|code\|discord\|wallet, rotateSeconds?, requirements?, codes?, codesSingleUse? }, tags?, deadlineSeconds?, feedbackPublicKey?, feedbackPrompts?, feedbackVisibility?: private\|public }`. Returns `{ poll, organizerKey }` — **the organizer key is shown once**. |
| `GET /api/polls/{id}` | Public | Poll metadata + aggregate tallies. |
| `PATCH /api/polls/{id}` | Organizer key · 20/min | Edit a **draft**. Body `{ organizerKey?, title?, description?, options?, questions?, tags?, deadlineSeconds? }`. |
| `DELETE /api/polls/{id}` | Organizer key · 20/min | Remove a closed/cancelled poll that received no votes. Body `{ organizerKey? }`. |
| `POST /api/polls/{id}/activate` | Organizer key · 20/min | draft → active. Body `{ organizerKey? }`. |
| `POST /api/polls/{id}/close` | Organizer key · 20/min | active → closed; result finalises. |
| `POST /api/polls/{id}/cancel` | Organizer key · 20/min | Discard a draft. |
| `POST /api/polls/{id}/verify-organizer` | Organizer key · 10/min | Check whether a key/session grants admin access. No side effects. |
| `POST /api/polls/{id}/checkin-code` | Organizer key · 120/min | Current rotating check-in code + seconds until rotation (for the host QR). |
| `POST /api/polls/{id}/enter` | Public · 15/min | Check-in against the eligibility policy. Body `{ deviceId?, checkinCode?, accessCode? }`. Issues an eligibility ticket; no-op for open polls. |
| `POST /api/polls/{id}/vote` | Public · 20/min | Cast a private vote. Body `{ answers: number[][] (one array per question, option indices), segment?, deviceId? }`. Duplicates rejected via nullifier (`409 ALREADY_VOTED`). |
| `POST /api/polls/{id}/receipt` | Public · 30/min | This device/session's existing vote receipt (participation only). Body `{ deviceId? }`. |
| `POST /api/polls/{id}/participation` | Public · 10/min | Prove "I participated" without revealing the ballot. Body `{ deviceId? }`. |
| `POST /api/polls/{id}/feedback` | Public · 10/min | Submit E2E-encrypted survey feedback. Body `{ encryptedPayload (≤2048), deviceId? }`. |
| `POST /api/polls/{id}/feedback/list` | Organizer key | Encrypted feedback envelopes for the organizer to decrypt client-side. Body `{ organizerKey? }`. |
| `GET /api/polls/{id}/feedback/public` | Public | Anonymous feedback for polls with a *public* feedback box, after close. |

### Inbox & profile

| Method & path | Auth | Description |
|---|---|---|
| `GET /api/inbox` | Session | The session wallet's inbox (messages + unread count). No wallet parameter by design. |
| `POST /api/inbox` | Session | Mark the inbox read. |
| `POST /api/inbox/{id}/respond` | Session (invite recipient) · 20/min | Body `{ action: accept\|decline }`. Accepting still checks token/NFT gating (`403 REQUIREMENTS_NOT_MET`). |
| `GET /api/profile/alias?address=` | Public | Display alias or `null`. |
| `POST /api/profile/alias` | API key | Body `{ walletAddress, alias (2–24 chars) }`. `409 ALIAS_TAKEN`, `422 ALIAS_INVALID`. |

### Subscription / billing

Platform tiers (Free / Starter $10 / Community $50 / Growth $250) via PayPal
Subscriptions. Gates only enforce once `PAYPAL_*` is fully configured.

| Method & path | Auth | Description |
|---|---|---|
| `GET /api/subscription/config` | Public | `{ configured, enforced, env, clientId, plans: {1,2,3} }` for the pricing page. |
| `GET /api/subscription/status?wallet=` | Public | Current tier + entitlement for a wallet. |
| `POST /api/subscription/challenge` | Public | Start a wallet-ownership proof before checkout. Body `{ walletAddress, chain }`. Returns CIP-30 message, Xaman QR, or an attested challenge. |
| `POST /api/subscription/verify` | Public | Body `{ challenge, signature?, key? }`. Xaman challenges are verified by re-reading the payload. |
| `POST /api/subscription/confirm` | Public | After PayPal `onApprove`. Body `{ challenge, subscriptionId }`; re-fetched from PayPal and bound to the verified wallet. `201`. |
| `POST /api/subscription/upgrade` | Session (wallet = `walletAddress`) | Body `{ walletAddress, targetTier: 1\|2\|3 }`. Returns `{ approveUrl }`. |
| `POST /api/subscription/sync` | Session (wallet = `walletAddress`) | Re-read the subscription from PayPal. Body `{ walletAddress }`. |
| `POST /api/subscription/cancel` | Session (wallet = `walletAddress`) | Stop future billing. Body `{ walletAddress }`. Returns `{ status, tier, accessUntil }`. |

### Contact

| Method & path | Auth | Description |
|---|---|---|
| `POST /api/contact` | API key · 5/hour | Contact-form submission. Body `{ name, email, subject?, message (≥10 chars) }`. Stored; emailed when Resend is configured. `201 { id, delivery }`. |

### Webhooks

Registered with the provider; not for direct use.

| Method & path | Auth | Description |
|---|---|---|
| `POST /api/discord/interactions` | Signed webhook (Ed25519) | Discord slash commands / buttons. `503` until `DISCORD_*` is configured; `401` on bad signature. Handlers in `lib/discord/interactions.ts`. |
| `POST /api/paypal/webhook` | Signed webhook | `BILLING.SUBSCRIPTION.*` / `PAYMENT.SALE.COMPLETED`. Verified via PayPal, then the subscription is re-fetched (event body never trusted). |
| `POST /api/wallet/xaman/webhook` | Re-verified · 60/min | Xaman payload resolution for the Discord scan-to-link flow. Always `200`. |

### Internal

| Method & path | Auth | Description |
|---|---|---|
| `POST /api/internal/warm-midnight` | Internal secret (if set) | Kick the background Midnight server-wallet warm-up. Called by `instrumentation.ts` at boot. |
| `POST /api/internal/import-data?force=1` | Internal secret (required) | Import `.data/*.json` into the Postgres document store. `503 DISABLED` when `BOT_INTERNAL_SECRET` is unset, `503 NO_DATABASE` without `DATABASE_URL`. |

---

## Implementation pointers

- Response helpers / error mapping: `lib/api/respond.ts`
- API-key gate: `lib/api/game-auth.ts` (`requireGameKey`, `resolveApiKey`)
- Session gate: `lib/api/wallet-auth.ts` (`requireWalletSession`)
- Per-client key store + CLI: `lib/api-keys/`, `scripts/api-keys/manage.ts`
- Rate limiting: `lib/api/rate-limit.ts`; CORS: `middleware.ts`
- Body schemas: `lib/domain/schemas.ts` (+ inline zod schemas in some routes)
- Smoke test for the key gate: `bash scripts/api-keys/smoke.sh <key> [base]`
