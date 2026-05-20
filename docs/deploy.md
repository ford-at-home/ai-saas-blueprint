# Deploy runbook

## Stamp a new product

```bash
# 1. Pick a product name. Use lowercase, hyphens. This becomes a prefix on every AWS resource.
export APP=support-bot

# 2. Bootstrap the target AWS account/region once (skip if already done).
cd infra && npx cdk bootstrap

# 3. Deploy.
npx cdk deploy --all -c app=$APP
```

That's it. The deploy creates:

- `<APP>-Auth` stack: Cognito user pool, app client, pre-token Lambda
- `<APP>-Data` stack: DynamoDB table, S3 bucket
- `<APP>-Api` stack: HTTP API + JWT authorizer + handler Lambdas
- `<APP>-Workflow` stack: Step Functions state machine, Bedrock IAM
- `<APP>-Billing` stack: Stripe webhook Function URL, Secrets Manager secret

## Wire up Stripe (one-time per product)

```bash
# 1. In Stripe Dashboard, create products and prices for "free" and "pro" tiers.
#    Copy the price IDs.

# 2. Put Stripe keys into the Secrets Manager secret CDK created.
aws secretsmanager put-secret-value \
  --secret-id "$APP/stripe" \
  --secret-string '{"secretKey":"sk_live_...","webhookSecret":"whsec_..."}'

# 3. Grab the webhook Function URL from CDK outputs.
aws cloudformation describe-stacks \
  --stack-name "${APP}-Billing" \
  --query "Stacks[0].Outputs[?OutputKey=='StripeWebhookUrl'].OutputValue" \
  --output text

# 4. Register that URL in Stripe Dashboard → Developers → Webhooks.
#    Subscribe to: checkout.session.completed, customer.subscription.updated,
#                  customer.subscription.deleted

# 5. Stripe Dashboard will show a signing secret. Update Secrets Manager with it.
```

## Add a workflow to an existing product

```bash
mkdir -p workflows/document-review
$EDITOR workflows/document-review/workflow.yaml
$EDITOR workflows/document-review/system-prompt.md

# Redeploy. Only the WorkflowStack changes; everything else is a no-op diff.
cd infra && npx cdk deploy "${APP}-Workflow" -c app=$APP
```

## Tear down a product

```bash
cd infra && npx cdk destroy --all -c app=$APP
```

DynamoDB tables and S3 buckets have `RemovalPolicy.RETAIN` by default. Empty + delete them manually if you really want them gone.

## Multi-environment

Add a second context for environment:

```bash
npx cdk deploy --all -c app=support-bot -c env=staging
npx cdk deploy --all -c app=support-bot -c env=prod
```

Stack names become `<APP>-<env>-<Stack>`, so staging and prod live in the same account without colliding. Recommended: separate AWS accounts per env via `cdk.json` `env` field once you have more than one paying customer.

## What CDK context controls

| Key | Required | Default | Effect |
|-----|----------|---------|--------|
| `app` | yes | — | Resource name prefix. Lowercase, hyphens. |
| `env` | no | `dev` | Environment suffix on stack names. |
| `bedrockModelId` | no | `anthropic.claude-3-5-sonnet-20241022-v2:0` | Model used by workflows. |
| `defaultPlan` | no | `free` | Plan assigned to new tenants. |
| `monthlySpendAlarmUsd` | no | `100` | Triggers CloudWatch alarm. |
