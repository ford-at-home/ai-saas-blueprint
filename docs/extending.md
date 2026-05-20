# Extending the blueprint

Recipes for the common extension points. Each recipe assumes you've read `CLAUDE.md` and at least skimmed `docs/architecture.md`.

If a recipe doesn't exist for what you're trying to do, the change is probably architectural. Open an ADR first.

## 1. Add a new workflow to an existing product

Goal: a tenant on the `pro` plan can run `POST /workflows/document-review/runs`.

```bash
mkdir -p workflows/document-review
$EDITOR workflows/document-review/workflow.yaml
$EDITOR workflows/document-review/system-prompt.md
```

`workflow.yaml` shape:

```yaml
id: document-review
name: Document Review
description: |
  Two-step workflow: extract key clauses, then summarize for legal review.
type: step_function   # or 'chatbot' for single-turn

inputs:
  - name: documentText
    type: string
    required: true
  - name: focusAreas
    type: array
    required: false

model:
  provider: bedrock
  model_id: anthropic.claude-3-5-sonnet-20241022-v2:0
  max_tokens: 4096
  temperature: 0.1

steps:           # only for type: step_function
  - id: extract
    prompt_template: "Extract key clauses from: {documentText}. Focus areas: {focusAreas}"
  - id: summarize
    depends_on: [extract]
    prompt_template: "Summarize these clauses for legal review: {extract.output}"

outputs:
  storage: dynamodb
  artifacts: s3
```

Then redeploy:

```bash
cd infra && npx cdk deploy "<app>-<env>-Workflow" -c app=<app>
```

Only `WorkflowStack` changes; the other stacks are no-op diffs. The workflow runner Lambda discovers the new folder at runtime (Phase 0 task 5 wires this; today the example workflow is hard-coded into the state machine).

**What you do NOT need to do:**

- Add a route to `ApiStack`. The route `POST /workflows/{workflowId}/runs` is generic.
- Update Cognito.
- Update billing.

**What you DO need to do for production:**

- Decide which plans get access. Add the workflow id to `packages/shared/PLANS[plan].limits.features` if you want plan-gated workflows. Default: all paid tenants get all workflows.
- Write a smoke test that runs the workflow against a test tenant.

## 2. Add a new HTTP API route

Example: `GET /tenants/me/usage` returning the current month's usage.

1. Add the handler logic to `lambdas/api/index.ts` (route on method + path).
2. Add the route in `infra/lib/api-stack.ts`:
    ```ts
    for (const route of [
      'GET /tenants/me',
      'GET /tenants/me/usage',   // new
      // ...
    ]) { ... }
    ```
3. Redeploy `ApiStack`.

No ADR needed for additive routes. ADR required if you're changing or removing an existing route's contract.

## 3. Add a new entity type to DynamoDB

Example: store webhook delivery audit rows.

1. Add the key shape to `packages/shared/src/index.ts`:
    ```ts
    export const Keys = {
      // ...
      webhookAudit: (tenantId: string, deliveryId: string) => ({
        PK: `TENANT#${tenantId}`,
        SK: `WEBHOOK_AUDIT#${deliveryId}`,
      }),
    } as const;
    ```
2. Use it in your handler.

No table change needed. The single-table design absorbs new entities for free as long as they share the `TENANT#<id>` partition convention.

If your access pattern requires a new query (e.g., "all webhook audits across tenants in the last hour") that can't be served by `Query(PK = TENANT#<id>)`, you need a GSI. Add it in `data-stack.ts` and open an ADR explaining why.

## 4. Add a new billing channel (e.g., AWS Marketplace)

This is the load-bearing extension. The whole point of `EntitlementProvider` is to make this not painful.

1. **New provider** (`packages/entitlement/src/marketplace-provider.ts`):
    ```ts
    export class MarketplaceEntitlementProvider implements EntitlementProvider {
      constructor(private deps: MarketplaceDeps) {}
      async getTenantPlan(tenantId: string) { /* read same DDB rows */ }
      async canRunWorkflow(tenantId: string, workflowId: string) { /* same logic */ }
      async recordUsage(tenantId: string, event: UsageEvent) { /* may call BatchMeterUsage */ }
    }
    ```
   The DDB rows look identical. Only the **writer** changes (Marketplace webhook handler instead of Stripe webhook handler).
2. **New Lambda** (`lambdas/marketplace-webhook/index.ts`) that handles the SNS subscription-events topic plus `ResolveCustomer` on first signup.
3. **New stack** (`infra/lib/marketplace-stack.ts`) wiring the Lambda + SNS subscription + IAM for `aws-marketplace:ResolveCustomer` and `aws-marketplace:GetEntitlements`.
4. **Wire it into `infra/bin/app.ts`**:
    ```ts
    if (config.enableMarketplace) {
      new MarketplaceStack(app, stackName(config, 'Marketplace'), { ... });
    }
    ```
5. **New ADR** documenting:
    - Buyer-to-tenant mapping (one Marketplace `CustomerIdentifier` → one tenant)
    - How the entitlement flag is set (which `EntitlementProvider` to use per tenant)
    - Concurrent Agreements handling (mandatory for new SaaS products on AWS Marketplace from June 2026)
6. **Add to deploy.md** the new outputs the customer needs to configure (Marketplace registration callback URL).

The workflow engine code does **not change**. Existing tenants continue using `StripeEntitlementProvider`. New Marketplace tenants get `MarketplaceEntitlementProvider`. Tenant rows carry `billingProvider` so the right provider is selected at lookup time.

## 5. Add a new CDK stack

Example: an `AnalyticsStack` that streams CloudWatch logs to a per-tenant analytics S3 prefix.

1. New file `infra/lib/analytics-stack.ts`. Follow the pattern in existing stacks:
    - Take `{ config, env, ...sharedResources }` in props
    - Name resources `${config.appName}-${config.env}-<role>`
    - Use `RemovalPolicy.RETAIN` on anything with customer data
    - Emit `CfnOutput`s for anything operators need
2. Wire in `infra/bin/app.ts`:
    ```ts
    new AnalyticsStack(app, stackName(config, 'Analytics'), { config, env, table: data.table });
    ```
3. Add to `docs/deploy.md`:
    - What it creates
    - Any one-time setup
    - Teardown notes
4. Verify with `cdk synth` for two distinct slugs that no resources collide.

## 6. Verify your change

Manual verification script:

```bash
# from repo root
npm install

cd infra
rm -rf cdk.out
npx cdk synth -c app=test-a --quiet > /tmp/test-a.log 2>&1
npx cdk synth -c app=test-b --quiet > /tmp/test-b.log 2>&1

# Both should exit 0
tail -1 /tmp/test-a.log /tmp/test-b.log

# Resource names should be app-prefixed
rg -oN '"(TableName|UserPoolName|FunctionName|StateMachineName|BucketName)":\s*"[^"]+"' cdk.out/

# Validation should reject bad input
npx cdk synth -c app=BAD_SLUG 2>&1 | grep "Invalid app slug"
npx cdk synth 2>&1 | grep "Missing required context"
```

Once you have a real test suite (Phase 0 task 3):

```bash
npm test                 # workspace-wide
npm test -w @ai-saas-blueprint/entitlement   # one package
```

## 7. Add a Lambda dependency

Lambdas are bundled by NodejsFunction's esbuild. To add a runtime dependency:

```bash
# at root, in workspace mode
npm install --workspace=@ai-saas-blueprint/entitlement @aws-sdk/client-dynamodb
```

esbuild will pull it into the bundle automatically. **Do NOT** mark AWS SDK v3 packages as external — Lambda's Node 20 runtime includes AWS SDK v3 in its environment, but the version may lag. Bundling is safer for reproducibility; the size hit is negligible at v1 volumes.

## 8. Run a local handler for smoke testing

Until the API is deployed, you can exercise handlers locally with a fake event:

```ts
// scratch/run-api.ts
import { handler } from '../lambdas/api';

const fakeEvent = {
  requestContext: {
    http: { method: 'GET', path: '/tenants/me' },
    authorizer: {
      jwt: { claims: { sub: 'test-user', 'custom:tenant_id': 't_test' } },
    },
  },
  headers: {},
} as any;

handler(fakeEvent).then(console.log);
```

Run with `npx ts-node scratch/run-api.ts`. Put scratch scripts in a `scratch/` dir (gitignored) for one-off probes.

## 9. Common failure modes and fixes

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `cdk synth` says `Missing required context: app` | Forgot `-c app=<slug>` | Add the flag, or set in `cdk.json` `context` |
| `Invalid app slug` | Uppercase or underscore in slug | Lowercase only, hyphens, 3-32 chars, leading letter |
| `Cannot find module '../lib/foo.js'` | Used `.js` extension in `infra/*.ts` import | Drop the `.js` — infra is CommonJS, not ESM |
| `Cannot find module '@ai-saas-blueprint/shared'` | Workspace not installed | Run `npm install` from repo root |
| `Resource handler returned message: "... already exists"` | Two deploys colliding on a global resource name | Check S3 bucket name (account-scoped global); pick a different app slug |
| Webhook returns 401 for Stripe test events | Webhook secret in Secrets Manager doesn't match Stripe Dashboard | Update via `aws secretsmanager put-secret-value` per `deploy.md §2` |
| Workflow run hangs in `pending` | Step Functions state machine failure | Check `/aws/vendedlogs/states/<app>-<env>-workflow` |
| Lambda cold start >2s | NodejsFunction bundle too large | Check bundle size; mark heavy deps as external + use Lambda layers |

## 10. When to write a new ADR vs. update an existing one

| Change | Action |
|--------|--------|
| Add a new capability layered on existing decisions | New ADR, refer back to prior |
| Change a v1 decision (e.g., move from pooled to siloed Cognito) | New ADR that **supersedes** the prior; mark the prior `Status: Superseded by NNNN` |
| Clarify wording without changing the decision | Edit the existing ADR; add a `Revisions` section at the bottom with date + reason |
| Add a non-goal that was implicit | Edit the existing ADR's non-goals section |

ADR numbering is monotonic. Don't reuse numbers. Even abandoned ADR drafts keep their number; mark them `Status: Withdrawn`.
