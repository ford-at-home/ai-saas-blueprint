# ADR 0002: EntitlementProvider interface

- Status: Accepted
- Date: 2026-05-20
- Depends on: ADR 0001

## Context

ADR 0001 commits v1 to Stripe-only billing. We expect to add AWS Marketplace and possibly metered/overage billing later. The workflow engine must not know which billing channel paid for a run.

## Decision

Define one TypeScript interface in `packages/entitlement`. The workflow engine consumes the interface, not a concrete provider. Each billing channel is an implementation.

```ts
export interface EntitlementProvider {
  getTenantPlan(tenantId: string): Promise<TenantPlan>;
  canRunWorkflow(tenantId: string, workflowId: string): Promise<EntitlementCheck>;
  recordUsage(tenantId: string, event: UsageEvent): Promise<void>;
}

export interface TenantPlan {
  tenantId: string;
  planId: string;             // 'free' | 'pro' | 'team' | 'enterprise'
  status: 'active' | 'past_due' | 'canceled' | 'trialing';
  limits: PlanLimits;
  billingProvider: 'stripe' | 'aws_marketplace' | 'manual';
}

export interface PlanLimits {
  maxRunsPerMonth: number;
  maxConcurrentRuns?: number;
  features: Record<string, boolean>;
}

export interface EntitlementCheck {
  allowed: boolean;
  reason?: 'plan_inactive' | 'quota_exceeded' | 'feature_disabled';
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
```

## Implementations

- **v1: `StripeEntitlementProvider`** — reads `TENANT#<id> / META` from DynamoDB. Plan/status mutated by the Stripe webhook handler. `recordUsage` increments a monthly counter in `TENANT#<id> / USAGE#<yyyy-mm>` via atomic `ADD`. No Stripe API calls on the hot path.
- **v2 (deferred): `MarketplaceEntitlementProvider`** — same data shape, populated by `ResolveCustomer` + `GetEntitlements` instead of Stripe webhooks. The workflow engine sees no difference.
- **v3 (deferred): `MeteredOverageProvider`** — wraps v1/v2; reports usage to Stripe Meters API or `BatchMeterUsage` asynchronously via EventBridge.

## Hot-path budget

Every workflow invocation calls `canRunWorkflow` once. Implementation must:

- Do at most one `GetItem` against the tenant META row
- Return in <50ms p95
- Cache results per Lambda warm container for up to 30s

## Failure modes

- `getTenantPlan` returns `null` → treat as `status: 'inactive'`, deny.
- `recordUsage` fails → log + emit CloudWatch metric, **do not block the run**. Usage drift is recoverable via reconciliation; blocked runs lose money.
- `canRunWorkflow` errors → fail closed (deny). Workflow runs only when entitlement is affirmatively granted.

## Consequences

- Adding Marketplace later requires writing one class. Zero changes to workflow runner, API handlers, or stack code.
- Testing the workflow engine uses an in-memory `EntitlementProvider` fake.
- Per-tenant rate limiting can be added as a decorator around any provider.
