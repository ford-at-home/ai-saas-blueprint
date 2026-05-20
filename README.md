# greenscreen

AI Workflow SaaS blueprint. One `cdk deploy` stamps a paywalled, tenant-aware AI workflow product.

## What this is

A reusable AWS CDK app. Each invocation with `-c app=<slug>` mints an isolated product: Cognito user pool, single DynamoDB table, HTTP API, Step Functions workflow, Bedrock invocations, and a Stripe Checkout paywall.

Same code. N independent deployments. Adding a workflow = a folder. Adding a product = one command.

Status: **skeleton synths clean**; handler bodies are intentional placeholders tracked in [`docs/phase-0-tasks.md`](docs/phase-0-tasks.md).

## Quickstart

```bash
npm install
cp .env.example .env  # fill in Stripe test keys when you reach Phase 0 task 6

cd infra
npx cdk bootstrap     # once per AWS account/region

# Deploy product A
npx cdk deploy --all -c app=demo-a

# Deploy product B (independent stack set, same code)
npx cdk deploy --all -c app=demo-b
```

See [`docs/deploy.md`](docs/deploy.md) for the full runbook.

## Documentation map

If you're picking this up cold, read in this order:

1. **[`CLAUDE.md`](CLAUDE.md)** — onboarding for agents and humans. Mission, hard rules, conventions.
2. **[`docs/adr/0001-v1-locked-decisions.md`](docs/adr/0001-v1-locked-decisions.md)** — what was decided and why.
3. **[`docs/architecture.md`](docs/architecture.md)** — system overview with diagrams.
4. **[`docs/phase-0-tasks.md`](docs/phase-0-tasks.md)** — ordered build list to first paying customer.

Reference docs:

- [`docs/adr/0002-entitlement-interface.md`](docs/adr/0002-entitlement-interface.md) — the abstraction that lets new billing channels land without touching the workflow engine
- [`docs/adr/0003-minimalist-paywall.md`](docs/adr/0003-minimalist-paywall.md) — exactly what v1 charges and how
- [`docs/data-model.md`](docs/data-model.md) — DynamoDB schema + access patterns
- [`docs/security.md`](docs/security.md) — defense-in-depth layers + threat model
- [`docs/extending.md`](docs/extending.md) — recipes for adding workflows, billing channels, stacks
- [`docs/deploy.md`](docs/deploy.md) — operational runbook
- [`research.txt`](research.txt) — original product spec
- [`ai-saas-workflow-blueprint-architecture.md`](ai-saas-workflow-blueprint-architecture.md) — background research

## Project layout

```
greenscreen/
  CLAUDE.md           agent/human onboarding (read first)
  README.md           you are here
  research.txt        original product spec
  ai-saas-workflow-blueprint-architecture.md  background research
  docs/               adrs + architecture + extension recipes
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

## v1 stack at a glance

| Layer | Choice | Why |
|-------|--------|-----|
| Identity | Cognito pooled, `custom:tenant_id` claim | Operationally simplest; siloed pools deferred until a customer pays for data residency |
| Data | DynamoDB single table, on-demand | One table per product; tenant prefix on every key; IAM `LeadingKeys` enforces isolation |
| Paywall | Stripe Checkout + 1 webhook on a Function URL | Smallest thing that charges money; Meters API and Marketplace deferred behind the EntitlementProvider interface |
| Workflows | Step Functions Standard + Bedrock direct | Native, visual, deterministic pricing; LangGraph on ECS deferred |
| LLM | Amazon Bedrock (Claude 3.5 Sonnet default) | No data egress, no training on customer data, IAM-native |
| Repo | npm workspaces, no Turborepo | Fewer moving parts; add bundlers when build time justifies |

Full rationale in [`docs/adr/0001-v1-locked-decisions.md`](docs/adr/0001-v1-locked-decisions.md).

## Verifying a fresh checkout

```bash
npm install
cd infra
npx cdk synth -c app=test-a --quiet | tail -3
npx cdk synth -c app=test-b --quiet | tail -3
# Both should report 5 stacks each, with distinct names: test-a-dev-* and test-b-dev-*
```

## License

TBD.
