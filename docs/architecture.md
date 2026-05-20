# Architecture

System overview for the v1 blueprint. For decision rationale see the ADRs. For data shape see `data-model.md`. For threat model see `security.md`.

## 1. Mental model

One `cdk deploy -c app=<slug>` produces one **product**. A product is five CloudFormation stacks deployed into one AWS account/region, all sharing a single Cognito user pool, a single DynamoDB table, and a single Step Functions state machine. The product hosts many **tenants** (paying customers). Each tenant runs many **workflows**.

```
AWS Account
└── Product: support-bot (one cdk deploy)
    ├── Tenant: acme-corp        ──┐
    ├── Tenant: globex-inc         │  All tenants share infra,
    ├── Tenant: initech            ├─ isolated by partition key
    └── ...                       ──┘   + IAM session tags
        Each tenant runs:
        ├── workflow: chatbot
        ├── workflow: document-review
        └── ...
```

You can deploy many products into the same AWS account. Resource names are prefixed by product slug; nothing collides.

## 2. Stack topology

```mermaid
graph TB
    subgraph "infra/bin/app.ts"
        Config[loadConfig - reads -c app=slug]
    end

    Config --> DataStack[DataStack<br/>DynamoDB table<br/>S3 artifacts bucket]
    Config --> AuthStack[AuthStack<br/>Cognito user pool<br/>App client]
    Config --> ApiStack[ApiStack<br/>HTTP API + JWT authorizer<br/>handler Lambda]
    Config --> WorkflowStack[WorkflowStack<br/>one state machine per workflow<br/>shared workflow runner Lambda]
    Config --> BillingStack[BillingStack<br/>Stripe webhook Lambda<br/>Function URL + DLQ<br/>Secrets Manager secret]

    DataStack -.table.-> ApiStack
    DataStack -.table.-> WorkflowStack
    DataStack -.table.-> BillingStack
    DataStack -.artifacts.-> WorkflowStack
    AuthStack -.userPool.-> ApiStack
    AuthStack -.userPoolClient.-> ApiStack
```

DataStack and AuthStack have no dependencies; everything else consumes them by reference. Deploys are ordered by CDK automatically based on these references.

## 3. Request flows

### 3.1 New tenant signup (v1: single-user-tenant)

```mermaid
sequenceDiagram
    actor User
    participant Cognito
    participant PostConfirm as PostConfirmation Lambda<br/>(Phase 0 task 1)
    participant DDB as DynamoDB

    User->>Cognito: Sign up (email, password)
    Cognito->>Cognito: Send verification email
    User->>Cognito: Confirm email
    Cognito->>PostConfirm: post-confirmation trigger
    PostConfirm->>DDB: PutItem TENANT#<new> META
    PostConfirm->>DDB: PutItem TENANT#<new> USER#<sub>
    PostConfirm->>Cognito: AdminUpdateUserAttributes<br/>custom:tenant_id=<new>
    Cognito-->>User: Confirmation complete
```

The post-confirmation Lambda is the only writer of `custom:tenant_id`. Once set, every subsequent JWT carries it.

### 3.2 Tenant upgrades to a paid plan

```mermaid
sequenceDiagram
    actor User
    participant Frontend
    participant API as HTTP API
    participant Stripe
    participant Webhook as Stripe Webhook Lambda
    participant DDB as DynamoDB

    User->>Frontend: Click "Upgrade to Pro"
    Frontend->>API: POST /billing/checkout (with JWT)
    API->>Stripe: Create Checkout Session<br/>client_reference_id = tenantId
    Stripe-->>API: { url }
    API-->>Frontend: { url }
    Frontend->>User: Redirect to checkout.stripe.com
    User->>Stripe: Pay with test card
    Stripe->>Webhook: POST checkout.session.completed
    Webhook->>Webhook: Verify Stripe-Signature
    Webhook->>DDB: PutItem STRIPE_EVENT#<id> (idempotency)
    Webhook->>DDB: UpdateItem TENANT#<id> META<br/>SET planId=pro, status=active
    Webhook-->>Stripe: 200 OK
```

Two important details:

- The `client_reference_id` in the Checkout Session is the tenantId. That's how the webhook knows whose plan to update.
- Idempotency: Stripe retries failed deliveries for 3 days. The `STRIPE_EVENT#<id>` row with `attribute_not_exists` makes retries safe.

### 3.3 Tenant runs a workflow

```mermaid
sequenceDiagram
    actor User
    participant API as HTTP API
    participant Engine as WorkflowRunner
    participant Entitle as EntitlementProvider
    participant DDB as DynamoDB
    participant SFN as Step Functions
    participant Bedrock

    User->>API: POST /workflows/chatbot/runs (with JWT)
    API->>API: Extract tenantId from JWT claims
    API->>Engine: start({ tenantId, workflowId, input })
    Engine->>Entitle: canRunWorkflow(tenantId, workflowId)
    Entitle->>DDB: GetItem TENANT#<id> META
    Entitle->>DDB: GetItem TENANT#<id> USAGE#<yyyy-mm>
    Entitle-->>Engine: { allowed: true, remaining: 4992 }
    Engine->>DDB: PutItem TENANT#<id> RUN#<runId>
    Engine->>SFN: StartExecution
    Engine->>Entitle: recordUsage({ unit: workflow_run, quantity: 1 })
    Entitle->>DDB: UpdateItem ADD count :1
    Engine-->>API: { runId, status: pending }
    API-->>User: 202 Accepted { runId }

    Note over SFN,Bedrock: Async execution
    SFN->>Bedrock: InvokeModel
    Bedrock-->>SFN: { completion, tokens }
    SFN->>DDB: UpdateItem RUN#<runId> SET status=succeeded
```

The synchronous path returns in <200ms. Workflow execution is async; clients poll `GET /workflows/<id>/runs/<runId>` or subscribe via WebSocket (Phase 1).

## 4. Code topology

```mermaid
graph LR
    subgraph "infra/"
        Stacks[5 CDK stacks]
    end

    subgraph "lambdas/"
        ApiL[api/index.ts]
        WebhookL[stripe-webhook/index.ts]
        RunnerL[workflow-runner/index.ts]
    end

    subgraph "packages/"
        Shared[shared<br/>types, keys, plans]
        Entitle[entitlement<br/>interface + Stripe impl]
        Engine[workflow-engine<br/>WorkflowRunner]
    end

    Stacks -.bundles via esbuild.-> ApiL
    Stacks -.bundles via esbuild.-> WebhookL
    Stacks -.bundles via esbuild.-> RunnerL

    ApiL --> Engine
    ApiL --> Entitle
    Engine --> Entitle
    Engine --> Shared
    Entitle --> Shared
    WebhookL --> Shared
    RunnerL --> Shared
```

Lambdas import workspace packages by name (`@ai-saas-blueprint/shared`). NodejsFunction's esbuild bundling resolves them through npm workspace symlinks and tree-shakes unused exports. No build step needed before `cdk synth`.

## 5. Deploy flow

```mermaid
graph TB
    Dev[Developer: pnpm cdk deploy -c app=foo]
    Dev --> Synth[cdk synth<br/>renders 5 CFN templates]
    Synth --> Bundle[esbuild bundles<br/>3 Lambdas to /tmp]
    Bundle --> Assets[Upload assets<br/>to CDK bootstrap bucket]
    Assets --> CFN1[CloudFormation deploy<br/>Data + Auth in parallel]
    CFN1 --> CFN2[Api, Workflow, Billing<br/>in parallel]
    CFN2 --> Done[Outputs:<br/>UserPoolId, ApiUrl,<br/>StripeWebhookUrl]
```

A fresh full deploy takes ~3-5 minutes. Incremental deploys (one stack changed) take ~30-90 seconds. The Stripe webhook URL must be registered in the Stripe Dashboard after first deploy; see `deploy.md §2`.

## 6. Per-product blast radius

What is shared across products in the same AWS account vs. isolated:

| Resource | Shared between products? |
|----------|--------------------------|
| AWS account | yes (intentionally; reduces ops cost at small scale) |
| IAM roles | no — each Lambda has its own role |
| CloudWatch logs | no — log groups are `/<app>/<env>/...` |
| DynamoDB table | no — one per product |
| S3 artifact bucket | no — one per product |
| Cognito user pool | no — one per product (a tenant of product A cannot log into product B) |
| Step Functions state machine | no — one per product |
| Stripe webhook endpoint | no — one Function URL per product |
| Secrets Manager secret | no — one per product per env |
| Bedrock model access | yes (IAM scopes to model ARN, which is account-wide) |

The shared items are bound by IAM and resource naming, not by namespace. Two products can be torn down independently with zero risk to each other's data.

## 7. Cost model at a glance

For per-run economics see `ai-saas-workflow-blueprint-architecture.md` §"AWS Cost Model." Calibrating expectations:

| Bucket | Order of magnitude |
|--------|---------------------|
| Per workflow run | ~$0.01 (Sonnet 4, 1K in / 500 out tokens) |
| Idle product (no traffic) | <$5/month (Cognito MAU free tier covers most cases) |
| 1,000 runs/day at Sonnet 4 | ~$10/day in Bedrock tokens, +~$1/day infra |
| Bedrock as % of run cost | ~95% |

The highest-leverage cost lever is model choice. The next is prompt length. Infrastructure costs are negligible until you have thousands of tenants.

## 8. Observability surfaces

Currently:

- CloudWatch Logs: `/aws/lambda/<app>-<env>-<role>`
- CloudWatch Logs: `/aws/vendedlogs/states/<app>-<env>-workflow`
- X-Ray tracing enabled on Lambdas and Step Functions

Phase 0 task 7 adds:

- Embedded Metric Format (EMF) for tenant-dimensioned metrics
- CloudWatch dashboards per product (workflow runs/min, errors, p95 latency, Bedrock token volume)
- Anomaly-detection alarm on monthly spend

The deeper pipeline (EMF → Firehose → S3 → Athena → QuickSight) from `ai-saas-workflow-blueprint-architecture.md` §"Observability" is deferred until tenant count justifies the build cost.

## 9. What's not yet wired

The skeleton synths and deploys, but the handlers are placeholders. Phase 0 task list (`docs/phase-0-tasks.md`) is the canonical TODO. Highest-leverage items first:

1. Cognito post-confirmation Lambda (creates tenant + user rows)
2. Pre-token-generation Lambda (injects `custom:tenant_id`)
3. Stripe webhook real implementation (signature check, idempotency, plan writes)
4. API handlers (`POST /workflows/{id}/runs`, etc.)
5. Workflow runner Bedrock invocation
6. Per-tenant isolation tests
