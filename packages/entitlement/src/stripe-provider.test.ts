import { describe, expect, it } from 'vitest';
import {
  StripeEntitlementProvider,
  type StripeEntitlementProviderDeps,
} from './stripe-provider.js';

/**
 * In-memory fake of the DDB-backed dependency surface. `reserveCounter`
 * mutates a Map atomically (single-threaded JS), which is precisely the
 * guarantee the real DynamoDB conditional UpdateItem provides under
 * concurrency. The test verifies the *wrapper* logic in
 * StripeEntitlementProvider given that contract.
 */
function makeFake(initial: {
  tenant?: { planId?: string; status?: string };
  counters?: Record<string, number>;
} = {}): {
  deps: StripeEntitlementProviderDeps;
  store: Map<string, Record<string, unknown>>;
} {
  const store = new Map<string, Record<string, unknown>>();
  if (initial.tenant) {
    store.set('TENANT#t1|META', {
      planId: initial.tenant.planId ?? 'pro',
      status: initial.tenant.status ?? 'active',
    });
  }
  for (const [sk, count] of Object.entries(initial.counters ?? {})) {
    store.set(`TENANT#t1|${sk}`, { count });
  }
  const deps: StripeEntitlementProviderDeps = {
    async getItem(key) {
      return store.get(`${key.PK}|${key.SK}`) ?? null;
    },
    async reserveCounter(key, max) {
      const mapKey = `${key.PK}|${key.SK}`;
      const current = Number(store.get(mapKey)?.count ?? 0);
      if (current >= max) return { reserved: false };
      const newCount = current + 1;
      store.set(mapKey, { count: newCount });
      return { reserved: true, newCount };
    },
    async recordTelemetry() {
      // no-op for these tests
    },
  };
  return { deps, store };
}

describe('StripeEntitlementProvider.reserveRun', () => {
  it('denies when tenant META row is missing', async () => {
    const { deps } = makeFake();
    const provider = new StripeEntitlementProvider(deps);
    const result = await provider.reserveRun('t1', 'chat');
    expect(result).toEqual({ allowed: false, reason: 'tenant_not_found' });
  });

  it('denies when plan status is canceled', async () => {
    const { deps } = makeFake({ tenant: { status: 'canceled' } });
    const provider = new StripeEntitlementProvider(deps);
    const result = await provider.reserveRun('t1', 'chat');
    expect(result).toEqual({ allowed: false, reason: 'plan_inactive' });
  });

  it('allows when under quota and increments the counter', async () => {
    const period = new Date().toISOString().slice(0, 7);
    const { deps, store } = makeFake({
      tenant: { planId: 'pro', status: 'active' },
      counters: { [`USAGE#${period}`]: 100 },
    });
    const provider = new StripeEntitlementProvider(deps);
    const result = await provider.reserveRun('t1', 'chat');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(5000 - 101);
    expect(store.get(`TENANT#t1|USAGE#${period}`)?.count).toBe(101);
  });

  it('denies when at quota and does NOT increment past the cap', async () => {
    const period = new Date().toISOString().slice(0, 7);
    const { deps, store } = makeFake({
      tenant: { planId: 'free', status: 'active' },
      counters: { [`USAGE#${period}`]: 50 },
    });
    const provider = new StripeEntitlementProvider(deps);
    const result = await provider.reserveRun('t1', 'chat');
    expect(result).toEqual({ allowed: false, reason: 'quota_exceeded', remaining: 0 });
    expect(store.get(`TENANT#t1|USAGE#${period}`)?.count).toBe(50);
  });

  it('treats N concurrent attempts at the boundary as exactly one success', async () => {
    // Free plan max = 50. Counter starts at 49. Ten parallel reservations
    // should produce one allowed + nine denied. The fake's reserveCounter
    // is atomic per-call (Map mutation in single-threaded JS), which is
    // the contract real DDB conditional writes provide.
    const period = new Date().toISOString().slice(0, 7);
    const { deps, store } = makeFake({
      tenant: { planId: 'free', status: 'active' },
      counters: { [`USAGE#${period}`]: 49 },
    });
    const provider = new StripeEntitlementProvider(deps);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => provider.reserveRun('t1', 'chat')),
    );
    const allowed = results.filter((r) => r.allowed).length;
    const denied = results.filter((r) => !r.allowed).length;
    expect(allowed).toBe(1);
    expect(denied).toBe(9);
    expect(store.get(`TENANT#t1|USAGE#${period}`)?.count).toBe(50);
  });
});
