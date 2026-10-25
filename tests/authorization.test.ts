import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { PolicyEngine } from '../src/services/authorization/index.js';

function engine(overrides: Record<string, string> = {}) {
  return new PolicyEngine(loadConfig({ ...overrides }));
}

const DEST = 'rMockMerchantAddressDoNotUseOnMainnet';

describe('PolicyEngine', () => {
  it('authorizes a payment within limits', () => {
    const p = engine();
    const d = p.authorize({ agentId: 'a', amountDrops: '1000000', invoiceId: 'inv1', destination: DEST, service: 'poll.create' });
    expect(d.ok).toBe(true);
  });

  it('rejects a destination not in the allow-list', () => {
    const p = engine();
    const d = p.authorize({ agentId: 'a', amountDrops: '1000000', invoiceId: 'inv1', destination: 'rEvil', service: 'poll.create' });
    expect(d.ok).toBe(false);
  });

  it('enforces the per-transaction limit', () => {
    const p = engine({ POLICY_PER_TX_LIMIT_XRP: '1' });
    const d = p.authorize({ agentId: 'a', amountDrops: '2000000', invoiceId: 'inv1', destination: DEST, service: 'poll.premium' });
    expect(d.ok).toBe(false);
  });

  it('enforces the daily allowance across recorded spends', () => {
    const p = engine({ POLICY_DAILY_LIMIT_XRP: '1.5', POLICY_HUMAN_APPROVAL_XRP: '100' });
    expect(p.authorize({ agentId: 'a', amountDrops: '1000000', invoiceId: 'i1', destination: DEST, service: 'poll.create' }).ok).toBe(true);
    p.recordSpend('a', '1000000', 'i1');
    const d = p.authorize({ agentId: 'a', amountDrops: '1000000', invoiceId: 'i2', destination: DEST, service: 'poll.create' });
    expect(d.ok).toBe(false);
  });

  it('requires human approval at/above the threshold, and lets an approval through', () => {
    const p = engine({ POLICY_HUMAN_APPROVAL_XRP: '1', POLICY_PER_TX_LIMIT_XRP: '5' });
    const first = p.authorize({ agentId: 'a', amountDrops: '2000000', invoiceId: 'inv-hi', destination: DEST, service: 'poll.premium' });
    expect(first.ok).toBe(false);
    expect(first.ok === false && first.requiresHumanApproval).toBe(true);
    p.approve('inv-hi');
    const second = p.authorize({ agentId: 'a', amountDrops: '2000000', invoiceId: 'inv-hi', destination: DEST, service: 'poll.premium' });
    expect(second.ok).toBe(true);
  });
});
