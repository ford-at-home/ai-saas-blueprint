# ADR 0003: minimalist v1 paywall

- Status: Accepted
- Date: 2026-05-20
- Depends on: ADR 0001, ADR 0002

## Context

The user goal is "set up the payment flow in as minimalist a way as possible." Stripe offers many integration depths. We pick the lowest one that still charges real money and supports plan tiers.

## Decision

Use **Stripe Checkout (hosted)** + **one webhook Lambda behind a Function URL**. No Stripe Elements, no Meters API, no Stripe-hosted Customer Portal in v1 (add in v2 if support tickets demand it).

## Flow

```
1. Tenant admin clicks "Upgrade" in the app
2. Backend creates a Checkout Session via Stripe API,
   passing tenantId in client_reference_id, returns the URL
3. User redirected to checkout.stripe.com (hosted by Stripe)
4. On success, Stripe posts webhook events to the Function URL:
   - checkout.session.completed      -> set Tenants.plan, Tenants.status='active'
   - customer.subscription.updated   -> update plan/status
   - customer.subscription.deleted   -> set status='canceled'
5. Workflow engine reads Tenants.plan via EntitlementProvider on every run
```

## What gets built in v1

| Component | Lines (target) | Owner |
|-----------|---------------:|-------|
| Stripe SDK client wrapper | ~50 | `packages/entitlement` |
| Checkout Session creator | ~30 | `lambdas/api` |
| Webhook handler (3 event types, signature verification) | ~120 | `lambdas/stripe-webhook` |
| Function URL + Secrets Manager wiring | CDK construct | `infra/lib/billing-stack.ts` |
| Plan definitions (free, pro) | YAML or constants | `packages/shared` |

Total payment-related code budget: ~200 LOC of handler logic. Everything else is CDK plumbing.

## What does NOT get built in v1

- Customer Portal (users cancel via Stripe email links until support volume forces this)
- Proration UI / mid-cycle upgrades (Stripe handles billing math; we just observe `subscription.updated`)
- Multiple currencies
- Coupon codes (Stripe Dashboard can issue these; no app code needed)
- Tax (Stripe Tax can be toggled on later in the Checkout Session)
- Dunning emails (Stripe sends them by default)
- Invoicing UI

## Plan tiers (v1)

Two tiers. We can run a real business on two.

| Plan | Price | Limit |
|------|-------|-------|
| free | $0/mo | 50 workflow runs/month |
| pro | $49/mo | 5,000 workflow runs/month |

Hard limits return HTTP 402 with `Retry-After` and current usage. No soft limits in v1.

## Security

- **Webhook signature.** Every incoming POST to the Function URL is rejected unless `Stripe-Signature` verifies against `STRIPE_WEBHOOK_SECRET` (Secrets Manager). Signature check is the **first** line of handler code, before parsing body.
- **Idempotency.** Stripe event IDs are written to `TENANT#<id> / STRIPE_EVENT#<eventId>` with `attribute_not_exists(SK)` condition. Duplicate deliveries no-op.
- **Replay window.** Reject events older than 5 minutes (`Stripe-Signature` timestamp).

## Failure modes

- Webhook delivery fails → Stripe retries with exponential backoff for up to 3 days. Our handler must be idempotent (above) and return 200 only after the DynamoDB write succeeds.
- Stripe outage during checkout → user sees Stripe's error page; no state change in our system.
- Tenant cancels at end of period → `subscription.deleted` fires at period_end; we keep `status='active'` until then because Stripe billed for the period.

## Migration paths

- **Add Marketplace:** new `MarketplaceEntitlementProvider`, new webhook Lambda for SNS subscription events. Same DynamoDB schema, same workflow engine.
- **Add usage billing:** Stripe Meters. Existing `recordUsage` already writes to DynamoDB; add an EventBridge → Stripe `meter_event` shim. No change to call sites.
- **Add Customer Portal:** one new API route, one Stripe API call. ~20 LOC.

## Why this and not [X]

- **Why not Stripe Elements?** Custom UI on top of Stripe.js. More code, more PCI surface area, no payoff at v1 volumes.
- **Why not the Meters API?** Usage billing is correct long-term but requires reconciliation, refund logic, and customer education. Subscription-with-hard-cap is honest at v1 scale and switches over once a customer asks.
- **Why Function URL instead of API Gateway?** Webhook has one route, no auth (signature verification is the auth), no CORS. API Gateway is two extra resources for zero benefit.
