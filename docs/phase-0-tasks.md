# Phase 0: from skeleton to first paying customer

Ordered checklist. Each task is small enough to land in one PR. Items marked `[infra]` change CDK; `[code]` change Lambda/package source; `[ops]` change AWS account or Stripe dashboard state.

## 0. Local environment

- [ ] `npm install` resolves clean
- [ ] `cd infra && npx cdk synth -c app=dev` produces a CloudFormation template with no errors
- [ ] `cd infra && npx cdk synth -c app=demo-b` produces a **disjoint** stack set (different stack names, different resource logical IDs)
- [ ] AWS credentials present (`aws sts get-caller-identity` works)
- [ ] `npx cdk bootstrap` in the target account/region

## 1. Identity (AuthStack) [infra] [code]

- [ ] Cognito user pool with `custom:tenant_id` string attribute
- [ ] App client with auth flows: `USER_SRP_AUTH`, `REFRESH_TOKEN_AUTH`
- [ ] Pre-token-generation Lambda: looks up `tenantId` from `TENANT#<id> / USER#<sub>`, injects into ID + access tokens
- [ ] Post-confirmation Lambda: creates `TENANT#<id>` row + `USER#<sub>` row on signup (single-user-tenant for v1; multi-user invites in Phase 1)
- [ ] Smoke test: sign up via Cognito hosted UI, inspect JWT, confirm `custom:tenant_id` present

## 2. Data (DataStack) [infra]

- [ ] Single DynamoDB table, on-demand, PK + SK strings
- [ ] Point-in-time recovery enabled
- [ ] S3 artifacts bucket with `tenants/<id>/*` prefix convention; SSE-S3 default
- [ ] CloudWatch alarm on table throttles

## 3. Entitlement layer [code]

- [ ] Implement `StripeEntitlementProvider` per ADR 0002
- [ ] Plan constants in `packages/shared`: free (50/mo), pro (5000/mo)
- [ ] Monthly counter reset via EventBridge cron at `0 0 1 * ? *`
- [ ] Unit tests with in-memory `EntitlementProvider` fake

## 4. API (ApiStack) [infra] [code]

- [ ] HTTP API with JWT authorizer pointing at the user pool
- [ ] `GET /tenants/me` — returns current tenant + plan
- [ ] `POST /billing/checkout` — creates Stripe Checkout Session, returns URL
- [ ] `GET /workflows` — lists workflows available to this tenant's plan
- [ ] `POST /workflows/{workflowId}/runs` — entitlement check → start state machine → return runId
- [ ] `GET /workflows/{workflowId}/runs/{runId}` — return status + result
- [ ] Tenant context middleware: extract `custom:tenant_id` from JWT claims, attach to request

## 5. Workflow execution (WorkflowStack) [infra] [code]

- [ ] Step Functions Standard state machine
- [ ] Bedrock `InvokeModel` direct SDK integration
- [ ] Result writes to `TENANT#<id> / RUN#<runId>` with status, output, token counts
- [ ] Usage recorder triggered by `ExecutionSucceeded` EventBridge event
- [ ] Hard timeout per execution (start: 5 minutes)
- [ ] Load `workflows/<id>/workflow.yaml` at synth time, convert to ASL

## 6. Billing (BillingStack) [infra] [code] [ops]

- [ ] Secrets Manager secret holding `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` (one secret, two fields)
- [ ] Stripe webhook Lambda with Function URL
- [ ] Signature verification + 5-minute replay window
- [ ] Idempotency via `STRIPE_EVENT#<id>` rows
- [ ] Handle: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`
- [ ] [ops] Stripe Dashboard: create products `free`, `pro`; create prices; copy IDs into `.env`/Secrets Manager
- [ ] [ops] Register webhook URL (Function URL) in Stripe Dashboard
- [ ] Smoke test: `stripe trigger checkout.session.completed`; confirm Tenants row updates

## 7. Observability [infra] [code]

- [ ] Structured logging via CloudWatch Embedded Metric Format with `tenantId` dimension on every handler
- [ ] X-Ray enabled on all Lambdas + Step Functions
- [ ] CloudWatch dashboard per product: workflow runs/min, error rate, p95 latency, Bedrock token volume
- [ ] Alarm: `monthly Bedrock spend > $X` (configurable in CDK context)

## 8. Tenant isolation audit [code]

Before any production traffic, prove these by test:

- [ ] User A cannot read User B's data via direct API calls (200 → empty result, never another tenant's data)
- [ ] Compromised Lambda role cannot scan the table beyond its tenant prefix (IAM `LeadingKeys` policy in place)
- [ ] Stripe webhook with invalid signature → 401, no DB write
- [ ] Stripe event delivered twice → second delivery is no-op (idempotency holds)

## 9. Frontend (deferred to Phase 1)

Once the backend can mint tenants and charge cards via curl + Stripe Dashboard, the frontend is mostly screens on top of the existing API. Build it after the backend is honest about money.

## Exit criteria for Phase 0

A test card in Stripe Checkout produces:

1. A new `TENANT#<id>` row with `plan='pro'`, `status='active'`
2. A successful workflow run against Bedrock that returns text
3. A usage counter incremented to 1
4. CloudWatch logs with `tenantId` field on every event

When all four are true, Phase 0 ships. Phase 1 starts with the frontend and a second workflow.
