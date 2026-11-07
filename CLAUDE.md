# CLAUDE.md — project context for AI agents and humans

This file is the entry point for anyone (agent or human) picking up this repo cold. Read it before you touch anything.

If you only read one section, read **§4 Hard rules**.

---

## 1. What this repo is

A reusable AWS CDK blueprint for stamping out paywalled, multi-tenant AI workflow SaaS products. One `cdk deploy -c app=<slug>` mints one product: Cognito user pool, single DynamoDB table, HTTP API, Step Functions workflow, Bedrock invocations, Stripe Checkout paywall.

Same code. N independent deployments. Adding a workflow is a folder. Adding a new product is one command.

It is **not** a finished product. It is a v1 skeleton that synths clean, with handler bodies stubbed and clearly marked. The work to make it actually charge cards and run Bedrock is captured in `docs/phase-0-tasks.md`.

## 2. Why it exists

The owner wants to ship AI workflow products quickly without rebuilding auth, billing, tenancy, and isolation each time. Existing reference implementations (AWS SaaS Factory, SBT, various Stripe SaaS boilerplates) each cover one slice. This repo composes the slices into one shape that works for solo or small-team operators: deploy cheaply, charge minimally, defer everything that isn't needed yet.

Origin documents:

- `research.txt` — original product spec ("AI Workflow SaaS Blueprint")
- `ai-saas-workflow-blueprint-architecture.md` — comprehensive research backing the spec
- `docs/adr/0001-v1-locked-decisions.md` — distilled decisions from those two

If you find yourself proposing something that conflicts with the ADRs, open a new ADR that supersedes the prior one rather than silently drifting.

## 3. Architectural philosophy

Three principles drive every decision:

### 3.1 Start with the operationally simplest option at each layer

Then add complexity **only when a paying customer's requirement demands it**. The decision matrix in `ai-saas-workflow-blueprint-architecture.md` §"Recommended Architecture" enumerates this for every layer.

Default v1 picks:

- **Auth:** pooled Cognito (one user pool per product, `custom:tenant_id` JWT claim)
- **Data:** single-table DynamoDB, on-demand
- **Billing:** Stripe Checkout + one webhook Lambda + Function URL
- **Workflow orchestration:** Step Functions Standard + Bedrock direct integration
- **LLM:** Amazon Bedrock (Claude 3.5 Sonnet default)
- **Repo:** npm workspaces, no Turborepo (until build times justify it)

Each upgrade path (siloed pools, Marketplace, LangGraph on ECS, etc.) is intentionally one ADR + one stack away.

### 3.2 Interface boundaries preserve options

The `EntitlementProvider` interface (`packages/entitlement/src/types.ts`) is the bright line between billing and product. The workflow engine does not know whether Stripe, AWS Marketplace, or a manual enterprise contract paid for a run. This is the load-bearing abstraction in v1; protect it.

When adding new capabilities, prefer a new interface implementation over branching inside existing code.

### 3.3 Minimalism is a feature, not a starting point

If you find yourself adding configuration, abstractions, or files "for flexibility," stop. v1 ships when it charges cards and runs Bedrock. Everything else is debt earning negative interest until then.

## 4. Hard rules

Violating any of these is a security or correctness defect. Code review must reject them.

### 4.1 Tenant identity flows from JWT, never from request body

```ts
// CORRECT
const tenantId = event.requestContext.authorizer.jwt.claims['custom:tenant_id'];

// WRONG — allows tenant spoofing
const { tenantId } = JSON.parse(event.body);
```

The pre-token-generation Lambda (Phase 0 task 1) is the only writer of `custom:tenant_id`. Treat the JWT as the only authoritative source after that.

### 4.2 Every DynamoDB key starts with `TENANT#<tenantId>`

Helper functions in `packages/shared/src/index.ts` produce these. **Use them.** Never hand-build a key string. The `dynamodb:LeadingKeys` IAM policy makes this enforceable at the platform level, but only if the application cooperates.

### 4.3 Tenant context must never flow through the LLM

When invoking Bedrock or any agent, tenant credentials and identity ride in deterministic channels — session attributes, IAM session tags, or Lambda environment — never in the prompt. The LLM can be prompt-injected; the IAM layer cannot be.

See `docs/security.md §3` for the full pattern.

### 4.4 Stripe webhook handler verifies signatures before reading the body

Every byte after `Stripe-Signature` verification is untrusted until proven otherwise. The check is the first thing the handler does, before parsing JSON, before any DB read.

### 4.5 Fail closed on entitlement checks

If `canRunWorkflow` throws or returns a malformed response, the workflow does **not** start. Errors deny by default. Logging a denied run is better than billing a tenant for something they didn't pay for, or running on a canceled subscription.

### 4.6 No mock data, no fallback values for user data

Workspace rule (see `~/CLAUDE.md`). If a tenant doesn't have a plan record, that's a real condition to handle (`tenant_not_found` reason), not a default-to-`free` shortcut. Defaults hide bugs.

### 4.7 Public APIs change via ADR

Anything that affects: JWT claim shape, DynamoDB key shapes, EntitlementProvider interface, Stripe webhook contract, or HTTP API surface — open or update an ADR before changing it. These are the seams customers and other systems integrate against.

### 4.8 Resources are RETAINED on stack delete by default

DynamoDB tables and S3 artifact buckets have `RemovalPolicy.RETAIN`. If you change this, write the reasoning into an ADR. Losing tenant data because of a typo is not recoverable.

## 5. Where things live

```
ai-saas-blueprint/
├── CLAUDE.md                ← you are here
├── README.md                ← human quickstart
├── LICENSE                  ← Apache-2.0
├── research.txt             ← original spec (source of truth for product intent)
├── ai-saas-workflow-blueprint-architecture.md  ← background research
├── vitest.config.ts         ← test runner config
├── .github/workflows/ci.yml ← synth + test on every PR
├── docs/
│   ├── adr/                 ← locked decisions; cite by number in commits
│   │   ├── 0001-v1-locked-decisions.md
│   │   ├── 0002-entitlement-interface.md       ← atomic reserveRun gate
│   │   ├── 0003-minimalist-paywall.md
│   │   ├── 0004-stripe-webhook-hardening.md    ← reserved concurrency + DLQ
│   │   ├── 0005-pricing-needs-validation.md    ← unit economics open question
│   │   ├── 0006-streaming-deferred.md
│   │   ├── 0007-bedrock-guardrails-stub.md
│   │   └── 0008-typed-api-clients.md
│   ├── runbooks/
│   │   └── tenant-deletion.md  ← GDPR/CCPA delete path
│   ├── architecture.md      ← system overview + Mermaid diagrams
│   ├── data-model.md        ← DynamoDB schema + access patterns
│   ├── security.md          ← defense-in-depth + threat model
│   ├── extending.md         ← recipes for adding workflows, billing, stacks
│   ├── phase-0-tasks.md     ← ordered build list to first paying customer
│   └── deploy.md            ← operational runbook
├── infra/                   ← the CDK app
│   ├── cdk.json             ← cdk-cli entry; runs bin/app.ts via ts-node
│   ├── bin/app.ts           ← reads -c app=<slug>, instantiates 5 stacks
│   └── lib/
│       ├── config.ts        ← context schema + validation (slug regex)
│       ├── auth-stack.ts    ← Cognito user pool + app client
│       ├── data-stack.ts    ← DynamoDB single table + S3 bucket
│       ├── api-stack.ts     ← HTTP API + JWT authorizer + handler
│       ├── workflow-stack.ts ← one SF state machine per workflow + Bedrock IAM
│       └── billing-stack.ts ← Stripe webhook Function URL + secret + DLQ
├── packages/
│   ├── shared/              ← types, plan constants, DDB key helpers
│   ├── entitlement/         ← EntitlementProvider interface + Stripe impl + tests
│   └── workflow-engine/     ← WorkflowRunner shell (reserveRun → SF start)
├── lambdas/
│   ├── api/index.ts                ← Phase 0 placeholder
│   ├── stripe-webhook/index.ts     ← Phase 0 placeholder
│   └── workflow-runner/index.ts    ← Phase 0 placeholder
└── workflows/
    └── example-chatbot/
        ├── workflow.yaml
        └── system-prompt.md
```

## 6. Naming conventions

| Thing | Convention | Example |
|-------|-----------|---------|
| Product slug (CDK `-c app=`) | lowercase, hyphens, 3-32 chars, starts with letter | `support-bot`, `claims-assistant` |
| Stack name | `<app>-<env>-<Stack>` | `support-bot-prod-Api` |
| Lambda function name | `<app>-<env>-<role>` | `support-bot-prod-stripe-webhook` |
| DynamoDB table name | `<app>-<env>` | `support-bot-prod` |
| S3 bucket | `<app>-<env>-artifacts-<account>` | `support-bot-prod-artifacts-123456789012` |
| Secrets Manager secret | `<app>/<env>/<purpose>` | `support-bot/prod/stripe` |
| DDB partition key (PK) | `TENANT#<tenantId>` | `TENANT#t_01HX9...` |
| DDB sort key (SK) by entity | see `packages/shared/Keys` | `META`, `USER#<sub>`, `RUN#<id>`, `USAGE#<yyyy-mm>` |
| Workflow id (folder name) | lowercase, hyphens | `example-chatbot`, `document-review` |

If you need a name that doesn't fit one of these patterns, that's a design smell. Reconsider.

## 7. Conventions for code

- TypeScript strict mode (`tsconfig.base.json`)
- Comments explain **why**, not what. Don't narrate the next line of code.
- Prefer deletion to addition. Each abstraction must earn its keep.
- async/await, never `.then()` chains
- ES modules in `packages/` and `lambdas/` (bundled by esbuild via NodejsFunction)
- CommonJS in `infra/` (CDK + ts-node convention; don't use `.js` extensions on local imports)
- One default export per module is fine; prefer named exports for shared utilities
- Tests go next to the file they test: `foo.ts` → `foo.test.ts`. Test framework decision deferred to Phase 0 task 3 (likely `vitest`)

## 8. What v1 does NOT do

These are intentional non-goals. If a customer asks for one of these, that's the trigger to open an ADR that promotes it from "deferred" to "in scope."

- SSO / external IdP federation
- AWS Marketplace listing or Concurrent Agreements support
- Metered / usage-based billing (Stripe Meters API)
- Per-tenant VPC isolation or BYO cloud account
- Frontend (defer until backend mints tenants and charges cards via curl + Stripe test mode)
- LangGraph
- Bedrock Guardrails (add when first compliance review demands)
- Multi-region active-active
- White-label custom domains per tenant
- Prompt caching, model routing (Sonnet ↔ Opus), advanced cost controls

## 9. Verification before claiming done

Before claiming any change is complete:

1. **`npm install`** clean
2. **`cd infra && npx cdk synth -c app=<slug>`** succeeds for at least two distinct slugs
3. **Resource names are app-prefixed** (grep the synthesized CloudFormation)
4. **No collisions** between two simultaneously-deployed products in the same account
5. **ADRs updated** if any public seam changed (JWT shape, DDB keys, EntitlementProvider, webhook contract, HTTP routes)
6. **Hard rules §4 still hold** — especially tenant-identity flow

Manual verification script (see `docs/extending.md §6`):

```bash
npm install
cd infra
npx cdk synth -c app=test-a > /tmp/test-a.synth.log 2>&1
npx cdk synth -c app=test-b > /tmp/test-b.synth.log 2>&1
diff <(ls cdk.out | grep test-a) <(ls cdk.out | grep test-b)  # should differ only in slug
```

## 10. How to make changes safely

| Change kind | Process |
|-------------|---------|
| Add a workflow | New folder under `workflows/<id>/`; redeploy `WorkflowStack`. See `docs/extending.md §1`. |
| Add an HTTP route | New handler in `lambdas/api/`, new route in `api-stack.ts`. ADR not required unless it changes existing route shape. |
| Add a billing channel (e.g., Marketplace) | New `EntitlementProvider` implementation; **do not modify** existing provider. New stack if it needs AWS resources. New ADR. |
| Add a stack | New file in `infra/lib/`, wire in `infra/bin/app.ts`. Add to deploy runbook. Add to teardown script. |
| Change DDB key shape | ADR required. Migration plan required. Backward-compatible by writing both shapes for one release. |
| Change Stripe webhook contract | ADR required. Coordinate with Stripe Dashboard endpoint version. |
| Change JWT claim shape | ADR required. Coordinate with API authorizers and frontend (when it exists). |

## 11. Things that have surprised people

Items future readers should not waste a half-day rediscovering:

- **`cdk.json` lives in `infra/`, not the repo root.** CDK CLI's `--app` lookup uses cwd. Stays cleaner when CDK is one workspace among many.
- **Infra uses CommonJS, packages and lambdas use ESM.** Don't put `.js` extensions on imports in `infra/lib/*.ts` files; ts-node + Node's CommonJS resolver won't follow them.
- **`packages/*/package.json` points `main` at `src/index.ts`** (not a compiled output). NodejsFunction's esbuild handles this fine; `tsc` would require an explicit `outDir`. We don't run `tsc` on packages today.
- **`RemovalPolicy.RETAIN`** on table and bucket means `cdk destroy` will not actually delete them. Empty + delete by hand if you really want them gone.
- **The Stripe webhook is on a Function URL, not API Gateway.** Stripe's signature scheme is the auth boundary. Don't put API Gateway in front "for security" — it adds cost and no protection.
- **The Step Functions state machine in v1 is a placeholder** (LambdaInvoke → Succeed). Phase 0 task 5 swaps in a real ASL generated from `workflows/<id>/workflow.yaml`.

## 12. Where to start if you're picking this up cold

1. Read this file (you're doing it)
2. Read `docs/adr/0001-v1-locked-decisions.md` — distilled decisions
3. Skim `docs/architecture.md` for the diagrams
4. Look at `docs/phase-0-tasks.md` — what's next, in order
5. Run `npm install && cd infra && npx cdk synth -c app=test` to confirm your environment works
6. Pick an unfinished Phase 0 task and open a branch named `phase-0/<task-id>`

When in doubt, the cheapest action is: read the ADRs, then ask. The second-cheapest is: do the minimum thing that makes the next test pass.

## 13. Workspace-level rules to remember

These come from `~/CLAUDE.md` and apply to everything you do here:

- No mock data, no fallback values for user data, no stub implementations
- Always commit and push after completing a task (after running tests; once tests exist)
- AWS commands use default profile, no `--profile` flag
- Read-only AWS analysis unless explicitly told to modify resources
- Never use `gh` CLI; use GitHub MCP tools if available, otherwise ask

User-level coding rules:

- Prioritize clarity over cleverness
- Each abstraction must earn its keep
- Favor deletion over addition
- Comments explain why, not what
- Working > perfect

And the one that applies to every PR-sized change in this repo:

> Weigh alternatives, pick one, articulate why, explain the approach, wait for confirmation, then code. Validate the change. Provide a commit message at the end.
