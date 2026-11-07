export type PlanId = 'free' | 'pro';

export const PLANS: Record<PlanId, PlanDefinition> = {
  free: {
    id: 'free',
    displayName: 'Free',
    priceUsdPerMonth: 0,
    limits: { maxRunsPerMonth: 50, features: {} },
  },
  pro: {
    id: 'pro',
    displayName: 'Pro',
    priceUsdPerMonth: 49,
    limits: { maxRunsPerMonth: 5000, features: { prioritySupport: true } },
  },
};

export interface PlanDefinition {
  id: PlanId;
  displayName: string;
  priceUsdPerMonth: number;
  limits: PlanLimits;
}

export interface PlanLimits {
  maxRunsPerMonth: number;
  maxConcurrentRuns?: number;
  features: Record<string, boolean>;
}

export interface Tenant {
  tenantId: string;
  planId: PlanId;
  status: TenantStatus;
  billingProvider: 'stripe' | 'aws_marketplace' | 'manual';
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  createdAt: string;
  updatedAt: string;
}

export type TenantStatus = 'active' | 'trialing' | 'past_due' | 'canceled';

export interface WorkflowRun {
  tenantId: string;
  runId: string;
  workflowId: string;
  /**
   * Content hash of `workflows/<id>/workflow.yaml` at run time.
   * Captured so historical runs remain interpretable after the workflow
   * definition changes. Populated by the WorkflowRunner in Phase 0 task 5.
   */
  workflowVersion?: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  startedAt: string;
  finishedAt?: string;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  errorMessage?: string;
  tokensInput?: number;
  tokensOutput?: number;
}

/** DynamoDB key shapes. Centralize so tests + handlers agree. */
export const Keys = {
  tenantMeta: (tenantId: string) => ({ PK: `TENANT#${tenantId}`, SK: 'META' }),
  tenantUser: (tenantId: string, cognitoSub: string) => ({
    PK: `TENANT#${tenantId}`,
    SK: `USER#${cognitoSub}`,
  }),
  workflowRun: (tenantId: string, runId: string) => ({
    PK: `TENANT#${tenantId}`,
    SK: `RUN#${runId}`,
  }),
  usageCounter: (tenantId: string, yyyymm: string) => ({
    PK: `TENANT#${tenantId}`,
    SK: `USAGE#${yyyymm}`,
  }),
  stripeEvent: (tenantId: string, eventId: string) => ({
    PK: `TENANT#${tenantId}`,
    SK: `STRIPE_EVENT#${eventId}`,
  }),
  /**
   * Append-only audit trail. Use ISO-8601 timestamps so SK sorts chronologically.
   * Written by: webhook handler on plan changes, admin tools on manual overrides.
   */
  audit: (tenantId: string, isoTs: string) => ({
    PK: `TENANT#${tenantId}`,
    SK: `AUDIT#${isoTs}`,
  }),
} as const;

export function currentBillingPeriod(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}
