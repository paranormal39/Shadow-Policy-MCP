/**
 * ServerContext — the dependency container. Built once at boot (or per-test with
 * overrides) and threaded into every tool handler.
 */
import { loadConfig, type ShadowPolicyConfig } from '../config/index.js';
import { PricingService } from '../services/pricing/index.js';
import { PolicyEngine } from '../services/authorization/index.js';
import { OrderStore } from '../services/orders/index.js';
import { ReceiptService } from '../services/receipts/index.js';
import { AgentRegistry } from '../services/agents/index.js';
import { ProvenanceStore } from '../services/provenance/index.js';
import { TreasuryGuard } from '../services/treasury/index.js';
import { TokenRegistry } from '../services/tokens/index.js';
import { StatsService } from '../services/stats/index.js';
import { resolve } from 'node:path';
import { InMemoryIdempotencyStore, type IdempotencyStore } from '../security/idempotency.js';
import { MockFacilitator } from '../integrations/xrpl/mock-facilitator.js';
import { T54XrplFacilitator } from '../integrations/xrpl/t54-facilitator.js';
import type { PaymentFacilitator } from '../integrations/xrpl/facilitator.js';
import { ShadowLabzClient } from '../integrations/shadowlabz/client.js';

export interface ServerContext {
  config: ShadowPolicyConfig;
  pricing: PricingService;
  policy: PolicyEngine;
  orders: OrderStore;
  receipts: ReceiptService;
  facilitator: PaymentFacilitator;
  shadowlabz: ShadowLabzClient;
  idempotency: IdempotencyStore;
  agents: AgentRegistry;
  provenance: ProvenanceStore;
  treasury: TreasuryGuard;
  tokens: TokenRegistry;
  stats: StatsService;
  /** When set (HTTP + token auth), the authenticated caller's agentId. Tool
   *  handlers use this instead of trusting an agentId argument. */
  callerAgentId?: string;
  /** The caller's votechain actor wallet, bound from the token. Tool handlers
   *  use this for wallet-addressed actions instead of trusting a body wallet. */
  callerWallet?: string;
  /** Chain of callerWallet (midnight | xrpl | xahau | cardano). */
  callerChain?: string;
}

export interface BuildContextOverrides {
  config?: ShadowPolicyConfig;
  facilitator?: PaymentFacilitator;
  shadowlabz?: ShadowLabzClient;
  fetchImpl?: typeof fetch;
}

export function buildContext(overrides: BuildContextOverrides = {}): ServerContext {
  const config = overrides.config ?? loadConfig();

  const facilitator: PaymentFacilitator =
    overrides.facilitator ??
    (config.facilitator === 't54'
      ? new T54XrplFacilitator(config.facilitatorUrl, overrides.fetchImpl)
      : new MockFacilitator());

  const shadowlabz =
    overrides.shadowlabz ??
    new ShadowLabzClient({
      baseUrl: config.shadowlabz.baseUrl,
      apiKey: config.shadowlabz.apiKey,
      fetchImpl: overrides.fetchImpl,
      timeoutMs: config.shadowlabz.timeoutMs,
      longTimeoutMs: config.shadowlabz.longTimeoutMs,
    });

  return {
    config,
    pricing: new PricingService(config),
    policy: new PolicyEngine(config),
    orders: new OrderStore(),
    receipts: new ReceiptService(config.receiptSigningSecret),
    facilitator,
    shadowlabz,
    idempotency: new InMemoryIdempotencyStore(),
    agents: new AgentRegistry(),
    provenance: new ProvenanceStore(),
    treasury: new TreasuryGuard(config.treasury),
    tokens: TokenRegistry.load({ envTokens: process.env.AGENT_TOKENS, file: resolve(process.cwd(), '.data/agent-tokens.json') }),
    stats: new StatsService(),
  };
}
