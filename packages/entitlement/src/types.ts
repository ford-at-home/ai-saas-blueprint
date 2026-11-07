import type { PlanId, PlanLimits } from '@ai-saas-blueprint/shared';

export interface EntitlementProvider {
  /** Plan + status snapshot. */
  getTenantPlan(tenantId: string): Promise<TenantPlan | null>;

  /**
   * Read-only preview suitable for UI ("you have X runs remaining").
   * Does not reserve anything; another caller can consume the remaining
   * quota between this call and a subsequent `reserveRun`.
   */
  canRunWorkflow(tenantId: string, workflowId: string): Promise<EntitlementCheck>;

  /**
   * Atomic reservation. The implementation must increment usage and check
   * the cap in a single conditional write so concurrent callers cannot both
   * succeed against the last remaining quota unit.
   *
   * If this returns `{allowed: false}`, no quota was consumed. The workflow
   * must NOT start.
   */
  reserveRun(tenantId: string, workflowId: string): Promise<EntitlementCheck>;

  /**
   * Post-run telemetry: token counts, model identity, custom units.
   * Does NOT affect the run-count quota — that's already been reserved.
   */
  recordUsage(tenantId: string, event: UsageEvent): Promise<void>;
}

export interface TenantPlan {
  tenantId: string;
  planId: PlanId;
  status: 'active' | 'past_due' | 'canceled' | 'trialing';
  limits: PlanLimits;
  billingProvider: 'stripe' | 'aws_marketplace' | 'manual';
}

export interface EntitlementCheck {
  allowed: boolean;
  reason?: 'plan_inactive' | 'quota_exceeded' | 'feature_disabled' | 'tenant_not_found';
  remaining?: number;
}

export interface UsageEvent {
  workflowId: string;
  runId: string;
  unit: 'message' | 'token_input' | 'token_output';
  quantity: number;
  model?: string;
  metadata?: Record<string, unknown>;
}
