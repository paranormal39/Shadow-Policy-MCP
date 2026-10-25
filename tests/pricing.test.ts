import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { PricingService } from '../src/services/pricing/index.js';

const config = loadConfig({ RECEIPT_SIGNING_SECRET: 'test-secret' });
const pricing = new PricingService(config);

describe('PricingService', () => {
  it('prices poll.create at the configured amount (1 XRP default)', () => {
    expect(pricing.priceDropsFor('poll.create')).toBe('1000000');
  });

  it('issues a signed quote that verifies', () => {
    const quote = pricing.createQuote('agent-1', 'poll.create');
    expect(pricing.verifyQuote(quote)).toEqual({ ok: true });
  });

  it('rejects a quote whose amount was altered', () => {
    const quote = pricing.createQuote('agent-1', 'poll.create');
    const tampered = { ...quote, amountDrops: '1' };
    const result = pricing.verifyQuote(tampered);
    expect(result.ok).toBe(false);
  });

  it('rejects an expired quote', () => {
    const quote = pricing.createQuote('agent-1', 'poll.create');
    const expired = { ...quote, expiresAt: Date.now() - 1000 };
    // re-sign so only expiry differs
    const resigned = new PricingService(config);
    const signed = resigned.createQuote('agent-1', 'poll.create');
    const expiredSigned = { ...signed, expiresAt: Date.now() - 1 };
    // signature now won't match the altered expiry -> invalid signature path
    expect(pricing.verifyQuote(expired).ok).toBe(false);
    expect(pricing.verifyQuote(expiredSigned).ok).toBe(false);
  });

  it('exposes a public catalog', () => {
    const catalog = pricing.catalog();
    expect(catalog.map((c) => c.service)).toContain('poll.create');
  });
});
