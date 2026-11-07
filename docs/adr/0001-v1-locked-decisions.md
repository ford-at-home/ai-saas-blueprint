# ADR 0001: v1 locked architecture decisions

- Status: Accepted
- Date: 2026-05-20
- Supersedes: none

## Context

We are building a reusable CDK blueprint that mints AI-workflow SaaS products. The product shell (auth, billing, tenancy, workflow execution) must be identical across products; only the workflow definition changes. The blueprint must be deployable many times with low friction. Payment in v1 must be the smallest thing that actually charges money.

Source material:

- `research.txt` — product spec
- `ai-saas-workflow-blueprint-architecture.md` — backing research

## Decisions

### D1. One CDK app, one deploy per product

`cdk deploy -c app=<name>` mints one product. Every resource name and stack name is prefixed by `appName`. Two deploys in the same AWS account do not collide.

**Alternatives rejected:**
- *Template repo, clone-per-product.* Platform fixes don't backport.
- *One platform deploy, many products as config rows.* Single blast radius; couples billing, branding, and lifecycle.

### D2. Pooled Cognito user pool with `custom:tenant_id` claim

A single user pool per product. Tenant identity is a custom attribute injected into JWTs via a pre-token-generation Lambda (Phase 0 task). Authorization derives `tenantId` from the verified JWT, never the request body.

Up to 10,000 groups per pool; sufficient for v1. Per-tenant pools deferred until a tenant pays for data residency or custom security policy (research §"Bridge model" disqualified due to the 1-hour cross-app-client session cookie leak).

### D3. Single-table DynamoDB

One table per product, on-demand capacity, `PK` string + `SK` string. Tenant scope enforced two ways:

1. Application code derives `tenantId` from JWT and prefixes every key with `TENANT#<id>`.
2. Lambda execution roles use `sts:AssumeRole` with `PrincipalTag/TenantId`; IAM policy uses `dynamodb:LeadingKeys` to make cross-tenant access impossible even with a compromised handler.

Schema (initial):

| PK | SK | Entity |
|----|-----|--------|
| `TENANT#<id>` | `META` | tenant metadata, plan, status, stripeCustomerId |
| `TENANT#<id>` | `USER#<cognitoSub>` | user → tenant mapping |
| `TENANT#<id>` | `RUN#<runId>` | workflow execution record |
| `TENANT#<id>` | `USAGE#<yyyy-mm>` | monthly counter (atomic ADD) |

### D4. Stripe-only paywall in v1

Stripe Checkout (hosted) + one webhook Lambda + Function URL for the webhook endpoint. No API Gateway in front of the webhook — Stripe doesn't need it, and the Function URL is one less resource.

Webhooks handled in v1: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`. Each writes to `TENANT#<id> / META`.

**Deferred:** Stripe Meters API (usage billing), AWS Marketplace, BatchMeterUsage, Concurrent Agreements. All hide behind the `EntitlementProvider` interface (ADR 0002) so adding them later doesn't touch the workflow engine.

### D5. Step Functions Standard + Bedrock direct integration

Each workflow is a state machine. Bedrock `InvokeModel` is called via the SF SDK integration — no Lambda intermediary for simple model calls. State machine ARN per product. Workflow body is loaded from `workflows/<id>/workflow.yaml` and converted to ASL at synth time.

**Deferred:** Express Workflows (switch when run volume justifies per-request pricing), LangGraph on ECS (when a workflow needs dynamic tool selection beyond what SF Map states allow).

### D6. Bedrock for LLM calls

Bedrock keeps prompts off the public internet, doesn't train on customer data, and integrates with IAM. Model ID is per-deploy context. Default: Claude 3.5 Sonnet.

**Deferred:** Bedrock Guardrails (add when first customer's compliance team asks), model tiering (Sonnet vs Opus routing), prompt caching.

## Non-goals for v1

- SSO / external IdP federation
- AWS Marketplace listing
- Metered / usage-based billing
- Per-tenant VPC isolation
- White-label custom domains per tenant
- Multi-region active-active
- LangGraph
- Bedrock Guardrails
- Frontend (built after backend mints tenants and charges cards)

Every non-goal is recoverable later without rewriting the v1 surface, because of the interface boundaries in ADR 0002.

## Consequences

- Adding a product = one folder + one `cdk deploy`.
- Adding a workflow to an existing product = one folder + one `cdk deploy`.
- Adding a billing channel = one new `EntitlementProvider` implementation; workflow engine unchanged.
- Migrating a tenant to a dedicated pool/table = data-layer migration; application code unchanged because tenant key shape is identical across pooled and siloed.

## References

- `ai-saas-workflow-blueprint-architecture.md` §"Cognito Multi-Tenant Identity", §"DynamoDB Data Modeling", §"Billing Architecture", §"Recommended Architecture"
- `research.txt` §"Multi-tenancy model", §"The biggest design decision"
