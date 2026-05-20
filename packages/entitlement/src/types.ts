import type { PlanId, PlanLimits } from '@greenscreen/shared';

export interface EntitlementProvider {
  getTenantPlan(tenantId: string): Promise<TenantPlan | null>;
  canRunWorkflow(tenantId: string, workflowId: string): Promise<EntitlementCheck>;
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
  unit: 'workflow_run' | 'message' | 'token_input' | 'token_output';
  quantity: number;
  model?: string;
  metadata?: Record<string, unknown>;
}
