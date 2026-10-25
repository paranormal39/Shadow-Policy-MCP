/**
 * Pricing service. Prices are fixed server-side from configuration; a quote is
 * signed (HMAC) over its immutable fields so an agent can never alter the
 * amount owed on an accepted quote — any tampering fails signature + expiry
 * verification.
 */
import { randomUUID } from 'node:crypto';
import { signPayload, verifyPayload } from '../../security/hash.js';
import type { PricingConfig, ShadowPolicyConfig } from '../../config/index.js';

export type ServiceKind = 'poll.create' | 'poll.premium' | 'results.purchase' | 'analytics';

export const SERVICE_LABELS: Record<ServiceKind, string> = {
  'poll.create': 'Create a Shadow Poll',
  'poll.premium': 'Create a premium Shadow Poll (segments / multi-select / advanced)',
  'results.purchase': 'Purchase authorized aggregate poll results',
  'analytics': 'Purchase poll analytics',
};

const QUOTE_TTL_MS = 15 * 60 * 1000;

/** The signed, immutable part of a quote. */
export interface QuoteCore {
  quoteId: string;
  agentId: string;
  service: ServiceKind;
  amountDrops: string;
  asset: string;
  network: string;
  payTo: string;
  invoiceId: string;
  /** Opaque resource this quote unlocks (e.g. "poll.create" or "poll:<id>:results"). */
  resource: string;
  createdAt: number;
  expiresAt: number;
}

export interface Quote extends QuoteCore {
  signature: string;
}

export class PricingService {
  constructor(private readonly config: ShadowPolicyConfig) {}

  priceDropsFor(service: ServiceKind): string {
    const p: PricingConfig = this.config.pricing;
    switch (service) {
      case 'poll.create':
        return p.pollCreateDrops;
      case 'poll.premium':
        return p.pollPremiumDrops;
      case 'results.purchase':
        return p.resultsPurchaseDrops;
      case 'analytics':
        return p.analyticsDrops;
    }
  }

  /** Public, unsigned price list for discovery. */
  catalog(): Array<{ service: ServiceKind; label: string; amountDrops: string; asset: string; network: string }> {
    return (Object.keys(SERVICE_LABELS) as ServiceKind[]).map((service) => ({
      service,
      label: SERVICE_LABELS[service],
      amountDrops: this.priceDropsFor(service),
      asset: this.config.merchantAsset,
      network: this.config.caip2,
    }));
  }

  createQuote(agentId: string, service: ServiceKind, resource?: string): Quote {
    const now = Date.now();
    const core: QuoteCore = {
      quoteId: `q_${randomUUID()}`,
      agentId,
      service,
      amountDrops: this.priceDropsFor(service),
      asset: this.config.merchantAsset,
      network: this.config.caip2,
      payTo: this.config.merchantAddress,
      invoiceId: `inv_${randomUUID()}`,
      resource: resource ?? service,
      createdAt: now,
      expiresAt: now + QUOTE_TTL_MS,
    };
    return { ...core, signature: this.sign(core) };
  }

  /** Verify a quote is authentic, unexpired, and its amount was not altered. */
  verifyQuote(quote: Quote): { ok: true } | { ok: false; reason: string } {
    const { signature, ...core } = quote;
    if (!verifyPayload(this.config.receiptSigningSecret, core, signature)) {
      return { ok: false, reason: 'Quote signature invalid (amount or fields were altered, or wrong server).' };
    }
    if (Date.now() > quote.expiresAt) return { ok: false, reason: 'Quote expired — request a fresh quote.' };
    // Defence-in-depth: price must still equal the configured price for the service.
    if (quote.amountDrops !== this.priceDropsFor(quote.service)) {
      return { ok: false, reason: 'Quoted amount does not match the server price.' };
    }
    return { ok: true };
  }

  private sign(core: QuoteCore): string {
    return signPayload(this.config.receiptSigningSecret, core);
  }
}
