/**
 * Environment-driven configuration with a hard testnet/mainnet safety guard.
 *
 * All amounts are normalised to XRP *drops* (integer strings) internally so we
 * never do floating-point math on money.
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { xrpToDrops } from '../security/money.js';

export type XrplNetwork = 'testnet' | 'devnet' | 'mainnet';
export type FacilitatorKind = 'mock' | 't54';
export type TransportKind = 'stdio' | 'http';

/** CAIP-2 network ids used by x402 (`xrpl:{id}`). */
export const CAIP2_BY_NETWORK: Record<XrplNetwork, string> = {
  mainnet: 'xrpl:0',
  testnet: 'xrpl:1',
  devnet: 'xrpl:2',
};

const DEFAULT_T54_URL: Record<XrplNetwork, string> = {
  testnet: 'https://xrpl-facilitator-testnet.t54.ai',
  devnet: 'https://xrpl-facilitator-testnet.t54.ai',
  mainnet: 'https://xrpl-facilitator-mainnet.t54.ai',
};

export interface PricingConfig {
  pollCreateDrops: string;
  pollPremiumDrops: string;
  resultsPurchaseDrops: string;
  analyticsDrops: string;
}

export interface PolicyDefaults {
  perTxLimitDrops: string;
  dailyLimitDrops: string;
  monthlyLimitDrops: string;
  humanApprovalDrops: string;
}

export interface TreasuryPolicy {
  /** Distinct approvals required before a treasury payment may execute. */
  approvalsRequired: number;
  /** Require the spend to be linked to a finalized governance proposal. */
  requireProposal: boolean;
}

export interface ShadowPolicyConfig {
  network: XrplNetwork;
  caip2: string;
  facilitator: FacilitatorKind;
  facilitatorUrl: string;
  merchantAddress: string;
  merchantAsset: string;
  transport: TransportKind;
  httpPort: number;
  httpAuthTokens: string[];
  shadowlabz: {
    baseUrl: string;
    publicUrl: string;
    apiKey: string | null;
    timeoutMs: number;
    longTimeoutMs: number;
  };
  receiptSigningSecret: string;
  pricing: PricingConfig;
  policy: PolicyDefaults;
  treasury: TreasuryPolicy;
}

const envSchema = z.object({
  XRPL_NETWORK: z.enum(['testnet', 'devnet', 'mainnet']).default('testnet'),
  ALLOW_MAINNET: z.string().optional(),
  TRANSPORT: z.enum(['stdio', 'http']).default('stdio'),
  // Railway (and most PaaS) inject PORT; it wins over HTTP_PORT when set.
  PORT: z.coerce.number().int().positive().max(65535).optional(),
  HTTP_PORT: z.coerce.number().int().positive().max(65535).default(8402),
  HTTP_AUTH_TOKENS: z.string().optional(),
  FACILITATOR: z.enum(['mock', 't54']).default('mock'),
  T54_FACILITATOR_URL: z.string().url().optional().or(z.literal('')),
  MERCHANT_XRPL_ADDRESS: z.string().default('rMockMerchantAddressDoNotUseOnMainnet'),
  MERCHANT_ASSET: z.string().default('XRP'),
  SHADOWLABZ_BASE_URL: z.string().url().default('http://localhost:3000'),
  SHADOWLABZ_PUBLIC_URL: z.string().url().optional().or(z.literal('')),
  SHADOWLABZ_API_KEY: z.string().optional(),
  SHADOWLABZ_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  SHADOWLABZ_ONCHAIN_TIMEOUT_MS: z.coerce.number().int().positive().default(180_000),
  RECEIPT_SIGNING_SECRET: z.string().optional(),
  PRICE_POLL_CREATE_XRP: z.string().default('1'),
  PRICE_POLL_PREMIUM_XRP: z.string().default('2'),
  PRICE_RESULTS_PURCHASE_XRP: z.string().default('0.5'),
  PRICE_ANALYTICS_XRP: z.string().default('0.5'),
  POLICY_PER_TX_LIMIT_XRP: z.string().default('5'),
  POLICY_DAILY_LIMIT_XRP: z.string().default('25'),
  POLICY_MONTHLY_LIMIT_XRP: z.string().default('100'),
  POLICY_HUMAN_APPROVAL_XRP: z.string().default('10'),
  TREASURY_APPROVALS_REQUIRED: z.coerce.number().int().min(1).max(20).default(2),
  TREASURY_REQUIRE_PROPOSAL: z.string().optional(),
});

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ShadowPolicyConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(`Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const e = parsed.data;
  const network = e.XRPL_NETWORK;

  // ── Hard mainnet guard ────────────────────────────────────────────────────
  if (network === 'mainnet' && e.ALLOW_MAINNET !== 'true') {
    throw new ConfigError('XRPL_NETWORK=mainnet requires ALLOW_MAINNET=true. Refusing to run against mainnet by default.');
  }

  const facilitatorUrl = (e.T54_FACILITATOR_URL && e.T54_FACILITATOR_URL.length > 0)
    ? e.T54_FACILITATOR_URL
    : DEFAULT_T54_URL[network];

  if (e.FACILITATOR === 't54' && e.MERCHANT_XRPL_ADDRESS === 'rMockMerchantAddressDoNotUseOnMainnet') {
    throw new ConfigError('FACILITATOR=t54 requires a real MERCHANT_XRPL_ADDRESS.');
  }

  const baseUrl = e.SHADOWLABZ_BASE_URL.replace(/\/$/, '');
  const publicUrl = (e.SHADOWLABZ_PUBLIC_URL && e.SHADOWLABZ_PUBLIC_URL.length > 0
    ? e.SHADOWLABZ_PUBLIC_URL
    : baseUrl).replace(/\/$/, '');

  return {
    network,
    caip2: CAIP2_BY_NETWORK[network],
    facilitator: e.FACILITATOR,
    facilitatorUrl,
    merchantAddress: e.MERCHANT_XRPL_ADDRESS,
    merchantAsset: e.MERCHANT_ASSET,
    transport: e.TRANSPORT,
    httpPort: e.PORT ?? e.HTTP_PORT,
    httpAuthTokens: (e.HTTP_AUTH_TOKENS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    shadowlabz: {
      baseUrl,
      publicUrl,
      apiKey: e.SHADOWLABZ_API_KEY && e.SHADOWLABZ_API_KEY.length > 0 ? e.SHADOWLABZ_API_KEY : null,
      timeoutMs: e.SHADOWLABZ_TIMEOUT_MS,
      longTimeoutMs: e.SHADOWLABZ_ONCHAIN_TIMEOUT_MS,
    },
    receiptSigningSecret: e.RECEIPT_SIGNING_SECRET && e.RECEIPT_SIGNING_SECRET.length > 0
      ? e.RECEIPT_SIGNING_SECRET
      : randomBytes(32).toString('hex'),
    pricing: {
      pollCreateDrops: xrpToDrops(e.PRICE_POLL_CREATE_XRP),
      pollPremiumDrops: xrpToDrops(e.PRICE_POLL_PREMIUM_XRP),
      resultsPurchaseDrops: xrpToDrops(e.PRICE_RESULTS_PURCHASE_XRP),
      analyticsDrops: xrpToDrops(e.PRICE_ANALYTICS_XRP),
    },
    policy: {
      perTxLimitDrops: xrpToDrops(e.POLICY_PER_TX_LIMIT_XRP),
      dailyLimitDrops: xrpToDrops(e.POLICY_DAILY_LIMIT_XRP),
      monthlyLimitDrops: xrpToDrops(e.POLICY_MONTHLY_LIMIT_XRP),
      humanApprovalDrops: xrpToDrops(e.POLICY_HUMAN_APPROVAL_XRP),
    },
    treasury: {
      approvalsRequired: e.TREASURY_APPROVALS_REQUIRED,
      requireProposal: e.TREASURY_REQUIRE_PROPOSAL !== 'false', // default true
    },
  };
}
