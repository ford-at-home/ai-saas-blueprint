import { currentBillingPeriod, Keys, PLANS, type PlanId } from '@ai-saas-blueprint/shared';
import type {
  EntitlementCheck,
  EntitlementProvider,
  TenantPlan,
  UsageEvent,
} from './types.js';

/**
 * Reads plan state from DynamoDB. The Stripe webhook handler is the only
 * writer for plan + status. This provider does no Stripe API calls on the
 * hot path; see ADR 0002.
 *
 * The DynamoDB client is injected so this package stays free of
 * @aws-sdk/* dependencies — Lambdas bring their own SDK.
 */
export class StripeEntitlementProvider implements EntitlementProvider {
  constructor(private readonly deps: StripeEntitlementProviderDeps) {}

  async getTenantPlan(tenantId: string): Promise<TenantPlan | null> {
    const item = await this.deps.getItem(Keys.tenantMeta(tenantId));
    if (!item) return null;
    const planId = (item.planId as PlanId) ?? 'free';
    const plan = PLANS[planId] ?? PLANS.free;
    return {
      tenantId,
      planId,
      status: (item.status as TenantPlan['status']) ?? 'active',
      limits: plan.limits,
      billingProvider: 'stripe',
    };
  }

  async canRunWorkflow(tenantId: string, _workflowId: string): Promise<EntitlementCheck> {
    const plan = await this.getTenantPlan(tenantId);
    if (!plan) return { allowed: false, reason: 'tenant_not_found' };
    if (plan.status !== 'active' && plan.status !== 'trialing') {
      return { allowed: false, reason: 'plan_inactive' };
    }
    const period = currentBillingPeriod();
    const counter = await this.deps.getItem(Keys.usageCounter(tenantId, period));
    const used = Number(counter?.count ?? 0);
    const remaining = plan.limits.maxRunsPerMonth - used;
    if (remaining <= 0) {
      return { allowed: false, reason: 'quota_exceeded', remaining: 0 };
    }
    return { allowed: true, remaining };
  }

  /**
   * Atomic: plan/status check is racy by nature (status can flip mid-flight),
   * but the quota gate is a single conditional UpdateItem that cannot
   * double-allocate the last remaining run unit.
   */
  async reserveRun(tenantId: string, _workflowId: string): Promise<EntitlementCheck> {
    const plan = await this.getTenantPlan(tenantId);
    if (!plan) return { allowed: false, reason: 'tenant_not_found' };
    if (plan.status !== 'active' && plan.status !== 'trialing') {
      return { allowed: false, reason: 'plan_inactive' };
    }
    const reservation = await this.deps.reserveCounter(
      Keys.usageCounter(tenantId, currentBillingPeriod()),
      plan.limits.maxRunsPerMonth,
    );
    if (!reservation.reserved) {
      return { allowed: false, reason: 'quota_exceeded', remaining: 0 };
    }
    return {
      allowed: true,
      remaining: plan.limits.maxRunsPerMonth - reservation.newCount,
    };
  }

  async recordUsage(tenantId: string, event: UsageEvent): Promise<void> {
    await this.deps.recordTelemetry(tenantId, event);
  }
}

export interface StripeEntitlementProviderDeps {
  getItem(key: { PK: string; SK: string }): Promise<Record<string, unknown> | null>;
  /**
   * Atomic conditional increment. Implementations MUST use a single
   * DynamoDB UpdateItem with a ConditionExpression that rejects the write
   * when the existing count would exceed `max`. Two concurrent calls at
   * count = max - 1 must produce exactly one `{reserved: true}` result.
   */
  reserveCounter(
    key: { PK: string; SK: string },
    max: number,
  ): Promise<{ reserved: false } | { reserved: true; newCount: number }>;
  recordTelemetry(tenantId: string, event: UsageEvent): Promise<void>;
}
