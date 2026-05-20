# ai-saas-blueprint

> One `cdk deploy` mints a paywalled, multi-tenant AI workflow SaaS on AWS.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![CDK](https://img.shields.io/badge/AWS_CDK-v2-orange.svg)](https://docs.aws.amazon.com/cdk/v2/guide/home.html)
[![Node](https://img.shields.io/badge/Node-20%2B-green.svg)](https://nodejs.org)
[![Status](https://img.shields.io/badge/status-skeleton_synths_clean-yellow.svg)](docs/phase-0-tasks.md)

A reusable AWS CDK app for stamping out independent AI-workflow products. Each invocation with `-c app=<slug>` deploys a fully isolated product: Cognito user pool, single-table DynamoDB, HTTP API behind a JWT authorizer, a Step Functions workflow that calls Bedrock, and a Stripe Checkout paywall.

**Same code. N independent deployments. Adding a workflow is a folder. Adding a product is one command.**

---

## What `cdk deploy` mints

A single deploy creates five stacks, all prefixed by your product slug:

| Stack | Resources |
|---|---|
| **Data** | One DynamoDB table (single-table design, on-demand) + S3 artifacts bucket. Both `RETAIN` on delete. |
| **Auth** | Cognito user pool with a `custom:tenant_id` claim + app client. |
| **Api** | HTTP API Gateway + JWT authorizer + handler Lambda. |
| **Workflow** | Step Functions Standard state machine + Bedrock IAM + runner Lambda. |
| **Billing** | Stripe webhook Lambda on a Function URL + Secrets Manager secret for the signing key. |

Status: **the skeleton synths clean**. Handler bodies are intentional placeholders, tracked in [`docs/phase-0-tasks.md`](docs/phase-0-tasks.md).

## Architecture at a glance

```mermaid
graph TB
    Config[infra/bin/app.ts<br/>loadConfig - reads -c app=slug]

    Config --> Data[DataStack<br/>DynamoDB + S3]
    Config --> Auth[AuthStack<br/>Cognito user pool]
    Config --> Api[ApiStack<br/>HTTP API + JWT authorizer]
    Config --> Workflow[WorkflowStack<br/>Step Functions + Bedrock]
    Config --> Billing[BillingStack<br/>Stripe webhook Function URL]

    Data -.table.-> Api
    Data -.table.-> Workflow
    Data -.table.-> Billing
    Data -.artifacts.-> Workflow
    Auth -.userPool.-> Api
```

`Data` and `Auth` have no dependencies; everything else consumes them by reference. Full diagrams (signup, paywall upgrade, workflow execution) live in [`docs/architecture.md`](docs/architecture.md).

## Quickstart

### Prerequisites

- Node 20+
- AWS credentials with permission to bootstrap and deploy CDK (uses default profile — no `--profile` flag)
- `npx cdk bootstrap` run once per account/region

### Deploy

```bash
npm install
cp .env.example .env   # fill in Stripe test keys when you reach Phase 0 task 6

cd infra
npx cdk deploy --all -c app=demo-a            # Product A
npx cdk deploy --all -c app=demo-b            # Product B, fully independent
```

Slugs must be lowercase, hyphen-separated, 3–32 chars, start with a letter. Full runbook: [`docs/deploy.md`](docs/deploy.md).

## Hard rules (security model)

These are non-negotiable. Code review rejects violations. Full text in [`CLAUDE.md §4`](CLAUDE.md).

1. **Tenant identity flows from the JWT**, never from the request body.
2. **Every DynamoDB key starts with `TENANT#<tenantId>`**, enforced by IAM `dynamodb:LeadingKeys`.
3. **Tenant context never flows through the LLM** — it rides in IAM/session tags, not prompts.
4. **The Stripe webhook verifies signatures before reading the body.**
5. **Entitlement checks fail closed.** A malformed plan record denies the run.
6. **No mock data, no fallback values for user data.** Missing data is a real condition, not a default.
7. **Public APIs change via ADR.** JWT shape, DDB keys, `EntitlementProvider`, webhook contract, HTTP surface.
8. **`RemovalPolicy.RETAIN` is the default** for tables and buckets. Losing tenant data to a typo is not recoverable.

## v1 stack at a glance

| Layer | Choice | Why |
|---|---|---|
| Identity | Cognito pooled, `custom:tenant_id` claim | Operationally simplest; siloed pools deferred until a customer pays for data residency |
| Data | DynamoDB single table, on-demand | One table per product; tenant prefix on every key; IAM `LeadingKeys` enforces isolation |
| Paywall | Stripe Checkout + 1 webhook on a Function URL | Smallest thing that charges money; Meters and Marketplace deferred behind the `EntitlementProvider` interface |
| Workflows | Step Functions Standard + Bedrock direct | Native, visual, deterministic pricing; LangGraph on ECS deferred |
| LLM | Amazon Bedrock (Claude 3.5 Sonnet default) | No data egress, no training on customer data, IAM-native |
| Repo | npm workspaces, no Turborepo | Fewer moving parts; add bundlers when build time justifies |

Full rationale: [`docs/adr/0001-v1-locked-decisions.md`](docs/adr/0001-v1-locked-decisions.md).

## Project layout

```
ai-saas-blueprint/
  CLAUDE.md           agent/human onboarding (read first)
  README.md           you are here
  research.txt        original product spec
  ai-saas-workflow-blueprint-architecture.md   background research
  docs/               ADRs, architecture, extension recipes
  infra/              CDK app (5 stacks per deploy)
  packages/           workspace libraries
    shared/             types, plan constants, DDB key helpers
    entitlement/        EntitlementProvider interface + Stripe impl
    workflow-engine/    WorkflowRunner shell
  lambdas/            handler sources (bundled by NodejsFunction)
    api/                Cognito-authenticated HTTP API
    stripe-webhook/     Stripe Function URL endpoint
    workflow-runner/    Step Functions task Lambda
  workflows/          one folder per product workflow
    example-chatbot/
```

## Documentation map

Picking this up cold? Read in this order:

1. [`CLAUDE.md`](CLAUDE.md) — mission, hard rules, conventions.
2. [`docs/adr/0001-v1-locked-decisions.md`](docs/adr/0001-v1-locked-decisions.md) — what was decided and why.
3. [`docs/architecture.md`](docs/architecture.md) — system overview with diagrams.
4. [`docs/phase-0-tasks.md`](docs/phase-0-tasks.md) — ordered build list to first paying customer.

Reference:

- [`docs/adr/0002-entitlement-interface.md`](docs/adr/0002-entitlement-interface.md) — abstraction that lets new billing channels land without touching the workflow engine
- [`docs/adr/0003-minimalist-paywall.md`](docs/adr/0003-minimalist-paywall.md) — exactly what v1 charges and how
- [`docs/data-model.md`](docs/data-model.md) — DynamoDB schema and access patterns
- [`docs/security.md`](docs/security.md) — defense-in-depth layers and threat model
- [`docs/extending.md`](docs/extending.md) — recipes for adding workflows, billing channels, stacks
- [`docs/deploy.md`](docs/deploy.md) — operational runbook
- [`research.txt`](research.txt) — original product spec
- [`ai-saas-workflow-blueprint-architecture.md`](ai-saas-workflow-blueprint-architecture.md) — background research

## Verifying a fresh checkout

Two synths with distinct slugs should produce two non-colliding sets of five stacks each:

```bash
npm install
cd infra
npx cdk synth -c app=test-a --quiet | tail -3
npx cdk synth -c app=test-b --quiet | tail -3
```

Expected: stack names like `test-a-dev-Api`, `test-a-dev-Auth`, ... and `test-b-dev-Api`, `test-b-dev-Auth`, ... with no overlap.

## License

[Apache 2.0](LICENSE).
