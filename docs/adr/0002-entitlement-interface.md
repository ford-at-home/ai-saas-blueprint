# ADR 0002: EntitlementProvider interface

- Status: Accepted (revised 2026-05-20: added `reserveRun` for atomic quota)
- Date: 2026-05-20
- Depends on: ADR 0001

## Context

ADR 0001 commits v1 to Stripe-only billing. We expect to add AWS Marketplace and possibly metered/overage billing later. The workflow engine must not know which billing channel paid for a run.

The original interface separated `canRunWorkflow` (read) and `recordUsage` (write). Two concurrent requests at the last remaining quota unit would both pass the check, both run, and the counter would overshoot the cap. The revision adds an atomic `reserveRun` so the gate is correct under concurrency.

## Decision

Define one TypeScript interface in `packages/entitlement`. The workflow engine consumes the interface, not a concrete provider. Each billing channel is an implementation.

```ts
export interface EntitlementProvider {
  getTenantPlan(tenantId: string): Promise<TenantPlan | null>;

  /** Read-only preview for UI; does NOT reserve quota. */
  canRunWorkflow(tenantId: string, workflowId: string): Promise<EntitlementCheck>;

  /** Atomic gate. Implementations must use a single conditional write. */
  reserveRun(tenantId: string, workflowId: string): Promise<EntitlementCheck>;

  /** Post-run telemetry (token counts, model). Does NOT affect quota. */
  recordUsage(tenantId: string, event: UsageEvent): Promise<void>;
}
```

`reserveRun` is the only authoritative quota gate. `canRunWorkflow` is a hint that may be stale by the time it's used and exists only so `GET /workflows` can show "you have X runs remaining."

## Implementations

- **v1: `StripeEntitlementProvider`** — reads `TENANT#<id> / META` from DynamoDB. Plan/status mutated by the Stripe webhook handler. `reserveRun` performs a single DynamoDB `UpdateItem` with `ConditionExpression: attribute_not_exists(PK) OR #count < :max` on `TENANT#<id> / USAGE#<yyyy-mm>`. No Stripe API calls on the hot path.
- **v2 (deferred): `MarketplaceEntitlementProvider`** — same data shape, populated by `ResolveCustomer` + `GetEntitlements`. The workflow engine sees no difference.
- **v3 (deferred): `MeteredOverageProvider`** — wraps v1/v2; reports usage to Stripe Meters API or `BatchMeterUsage` asynchronously via EventBridge.

## Hot-path budget

Every workflow invocation calls `reserveRun` once. Implementation must:

- Do at most one `GetItem` (plan/status) + one `UpdateItem` (atomic counter)
- Return in <80ms p95
- Cache plan/status per Lambda warm container for up to 30s; the conditional `UpdateItem` is always fresh

## Failure modes

- `getTenantPlan` returns `null` → deny with `tenant_not_found`.
- `reserveRun` returns `{allowed: false}` → workflow MUST NOT start. No quota was consumed.
- `reserveRun` succeeds but `persistRun` or `startStateMachine` fails → `WorkflowRunner` calls the optional `releaseRun` compensating action (decrement counter, best-effort). A leaked unit is recoverable on monthly reset; double-charging is not.
- `recordUsage` fails → log + emit CloudWatch metric, **do not block the run**. Telemetry drift is reconcilable; blocking runs loses money.
- Any provider error not classified above → fail closed (deny).

## Consequences

- Adding Marketplace later requires writing one class. Zero changes to workflow runner, API handlers, or stack code.
- Testing the workflow engine uses an in-memory `EntitlementProvider` fake.
- Per-tenant rate limiting can be added as a decorator around any provider.
- The atomic gate is a contract on implementations, not enforced by types. Code review must catch a `reserveRun` that does two writes instead of one.
