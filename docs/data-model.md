# Data model

DynamoDB single-table schema, access patterns, and tenant isolation enforcement. See `ADR 0001 §D3` for the rationale. See `security.md §2` for the IAM-level enforcement.

## 1. Table shape

One table per product, named `<app>-<env>`. On-demand billing, point-in-time recovery on, `RemovalPolicy.RETAIN`.

| Attribute | Type | Notes |
|-----------|------|-------|
| `PK` | String | partition key, always `TENANT#<tenantId>` |
| `SK` | String | sort key, entity-specific |

No GSIs in v1. Add only when an access pattern can't be served by a `Query` on `PK` + `SK` prefix. The most likely first GSI is `(stripeCustomerId → tenantId)` lookup for the webhook handler; defer until measurable.

## 2. Key shapes (canonical list)

Producing these by hand in handler code is a bug waiting to happen. Use the helpers in `packages/shared/src/index.ts`:

```ts
import { Keys, currentBillingPeriod } from '@greenscreen/shared';

Keys.tenantMeta('t_01HX9')                  // { PK: 'TENANT#t_01HX9', SK: 'META' }
Keys.tenantUser('t_01HX9', cognitoSub)      // { PK: 'TENANT#t_01HX9', SK: 'USER#<sub>' }
Keys.workflowRun('t_01HX9', 'r_abc')        // { PK: 'TENANT#t_01HX9', SK: 'RUN#r_abc' }
Keys.usageCounter('t_01HX9', '2026-05')     // { PK: 'TENANT#t_01HX9', SK: 'USAGE#2026-05' }
Keys.stripeEvent('t_01HX9', 'evt_abc')      // { PK: 'TENANT#t_01HX9', SK: 'STRIPE_EVENT#evt_abc' }
```

If you need a key shape not in this list, add it to `Keys` first, then use it. Centralization is the point.

## 3. Entities

### 3.1 Tenant metadata (`META`)

The source of truth for billing state. Mutated by the Stripe webhook handler only.

```jsonc
{
  "PK": "TENANT#t_01HX9...",
  "SK": "META",
  "tenantId": "t_01HX9...",
  "displayName": "Acme Corp",
  "planId": "pro",                    // 'free' | 'pro'
  "status": "active",                 // 'active' | 'trialing' | 'past_due' | 'canceled'
  "billingProvider": "stripe",        // 'stripe' | 'aws_marketplace' | 'manual'
  "stripeCustomerId": "cus_...",
  "stripeSubscriptionId": "sub_...",
  "createdAt": "2026-05-19T12:00:00Z",
  "updatedAt": "2026-05-20T14:23:11Z"
}
```

### 3.2 User → tenant mapping (`USER#<cognitoSub>`)

Maps a Cognito user to a tenant. In v1 one user belongs to exactly one tenant. The multi-user-tenant invite flow is Phase 1.

```jsonc
{
  "PK": "TENANT#t_01HX9...",
  "SK": "USER#a1b2c3d4-...",
  "userId": "a1b2c3d4-...",           // Cognito sub
  "email": "alice@acme.com",
  "role": "owner",                    // 'owner' | 'admin' | 'member'
  "createdAt": "2026-05-19T12:00:00Z"
}
```

The post-confirmation Lambda writes this. The pre-token-generation Lambda reads it to populate the JWT `custom:tenant_id` claim on every login.

### 3.3 Workflow run (`RUN#<runId>`)

One row per workflow execution. Written by the workflow runner, read by `GET /workflows/{id}/runs/{runId}`.

```jsonc
{
  "PK": "TENANT#t_01HX9...",
  "SK": "RUN#r_01HX...",
  "tenantId": "t_01HX9...",
  "runId": "r_01HX...",
  "workflowId": "chatbot",
  "userId": "a1b2c3d4-...",
  "status": "succeeded",              // 'pending' | 'running' | 'succeeded' | 'failed'
  "startedAt": "2026-05-20T14:00:00Z",
  "finishedAt": "2026-05-20T14:00:02Z",
  "input": { "message": "hello" },
  "output": { "completion": "..." },
  "tokensInput": 42,
  "tokensOutput": 128,
  "model": "anthropic.claude-3-5-sonnet-20241022-v2:0"
}
```

### 3.4 Monthly usage counter (`USAGE#<yyyy-mm>`)

Atomic counter incremented by `recordUsage`. Read by `canRunWorkflow` to enforce the monthly cap.

```jsonc
{
  "PK": "TENANT#t_01HX9...",
  "SK": "USAGE#2026-05",
  "count": 142,
  "lastUpdated": "2026-05-20T14:00:00Z"
}
```

Increment via `UpdateExpression: "ADD #count :delta"`. DynamoDB guarantees atomic semantics on `ADD` — no read-modify-write race.

### 3.5 Stripe event idempotency token (`STRIPE_EVENT#<id>`)

Written by the webhook handler with `attribute_not_exists(SK)`. Duplicate deliveries fail the condition and return 200 without further side effects.

```jsonc
{
  "PK": "TENANT#t_01HX9...",
  "SK": "STRIPE_EVENT#evt_1NXyz...",
  "eventId": "evt_1NXyz...",
  "eventType": "checkout.session.completed",
  "receivedAt": "2026-05-20T14:00:00Z",
  "ttl": 1747749600                   // 7 days after receivedAt; lets old rows expire
}
```

TTL is set so the table doesn't accumulate event rows forever. Stripe retries for 3 days; 7 days is a comfortable margin.

## 4. Access patterns

| Pattern | Operation | Notes |
|---------|-----------|-------|
| Read tenant plan/status | `GetItem(TENANT#<id>, META)` | Hot path for every workflow run. Cache per warm Lambda for 30s. |
| Read user → tenant mapping | `GetItem(TENANT#<known>, USER#<sub>)` | Only the pre-token Lambda knows the tenant; for raw login flows, see §5. |
| List recent runs for a tenant | `Query(PK = TENANT#<id>, SK begins_with 'RUN#')` | Add `ScanIndexForward=false` for newest-first. |
| List runs for one workflow | Same query + filter on `workflowId`. | If common, add a GSI on `(tenantId, workflowId)`. Not yet. |
| Increment monthly counter | `UpdateItem(TENANT#<id>, USAGE#<yyyy-mm>) ADD count :1` | Atomic. No condition. |
| Read current usage | `GetItem(TENANT#<id>, USAGE#<current-period>)` | Cache per warm Lambda for 30s. |
| Idempotently mark a Stripe event | `PutItem(... STRIPE_EVENT#<id>, ...) ConditionExpression: 'attribute_not_exists(SK)'` | Conditional check failure means duplicate. |
| Find tenant by Stripe customer | **NOT YET INDEXED.** Webhook payload carries `client_reference_id = tenantId`. | When that's not enough (e.g., `invoice.*` events lack it), add a GSI. |

## 5. The cold-start lookup problem

When a user logs in, Cognito has their `sub` but doesn't know their `tenantId` unless `custom:tenant_id` was set previously. The chicken-and-egg cases:

- **Fresh signup**: post-confirmation Lambda creates the tenant row, mints a `tenantId`, writes `USER#<sub>`, then sets `custom:tenant_id` via `AdminUpdateUserAttributes`. The next login carries it.
- **Login after attribute set**: `custom:tenant_id` is in the ID token; no lookup needed.
- **Login where attribute somehow missing** (edge case): pre-token Lambda must scan-or-query to find the right tenant. We avoid this by ensuring the post-confirmation Lambda is the only path to user creation. Admin-created users get the attribute set by the create script.

**Design rule:** the pre-token Lambda should be O(1) — a single `GetItem` keyed by `tenantId` derived from the existing `custom:tenant_id` claim. If you're tempted to add a `Scan` here, stop. Add a GSI keyed by `cognitoSub → tenantId` instead.

## 6. Isolation enforcement

The application *should* always scope its keys by tenant, but bugs happen. Two layers of defense:

### 6.1 Application layer

- All keys come from `Keys.*` helpers in `packages/shared`. No string concatenation in handlers.
- Tenant context is read once from JWT claims at the top of each handler and threaded down. Never re-read from request body.

### 6.2 IAM layer (defense in depth)

Lambda execution roles assume a tenant-scoped role on each invocation using `sts:AssumeRole` with a session tag `PrincipalTag/TenantId = <tenantId from JWT>`. The IAM policy on the assumed role:

```jsonc
{
  "Effect": "Allow",
  "Action": ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:UpdateItem"],
  "Resource": "arn:aws:dynamodb:*:*:table/<app>-<env>",
  "Condition": {
    "ForAllValues:StringEquals": {
      "dynamodb:LeadingKeys": ["TENANT#${aws:PrincipalTag/TenantId}"]
    }
  }
}
```

This means a compromised Lambda — even one with arbitrary code execution — cannot read or write any row that doesn't start with `TENANT#<the JWT's tenantId>`. It's not theoretical; this is the IAM mechanic AWS recommends in the [SaaS Lens](https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/saas-lens.html) and demonstrates in `aws-samples/aws-saas-factory-ref-solution-serverless-saas`.

Implementation lands in Phase 0 task 4 (API handlers) and task 8 (isolation tests).

## 7. Migration paths

### 7.1 Single-table → multi-table (per-tenant siloed)

When a high-volume tenant outgrows pooled capacity:

1. Provision a new table named `<app>-<env>-<tenantId>` with the same schema.
2. Scan the pooled table for `PK = TENANT#<tenantId>` and stream items to the new table.
3. Update the tenant's `META` row with `dedicatedTable: '<app>-<env>-<tenantId>'`.
4. Modify the DynamoDB client wrapper to read this field and route accordingly.
5. Once verified, delete the tenant's rows from the pooled table.

Application code does not change because key shapes are identical across pooled and siloed tables. This is the payoff of the `TENANT#<id>` prefix on every key.

### 7.2 Add a GSI

Costs scale with item count. Don't add one speculatively. When you do:

1. Add the GSI to `data-stack.ts` (CDK supports adding GSIs without table replacement).
2. Wait for backfill to complete (monitor `IndexStatus`).
3. Add an access pattern to `Keys` and handler code.
4. Open an ADR documenting the access pattern that justified it.

### 7.3 Add a new entity type

Just add a new `Keys.*` helper. No table change required.

## 8. What this schema deliberately does not do

- No GSIs (added when justified, not preemptively)
- No reverse-index pattern (`GSI1PK / GSI1SK`) — overkill for v1; we'll add named GSIs with meaningful keys when needed
- No TTLs except on Stripe event rows
- No streams to Lambda — added in Phase 1 if change-data-capture becomes useful
- No backup vault — point-in-time recovery covers v1; cross-region backup is a Phase 5 item

## 9. Tenant ID format

`t_` prefix + 26-character ULID. ULIDs sort lexicographically by creation time, which makes admin queries (`Scan` + filter, used sparingly) return tenants in roughly chronological order. The `t_` prefix makes them visually distinct from other ID classes in logs.

Generate via `crypto.randomUUID()` is acceptable; `ulid()` from a small library is preferred once tests exist.
