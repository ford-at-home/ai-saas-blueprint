# ADR 0004: Stripe webhook hardening

- Status: Accepted
- Date: 2026-05-20
- Depends on: ADR 0003

## Context

The Stripe webhook handler is on a Lambda Function URL with `authType: NONE`. Signature verification is the auth boundary (ADR 0003). Two failure modes were not addressed:

1. **Cost-DoS.** If the URL leaks, an attacker can fire requests indefinitely. Each request runs the Lambda far enough to reject the signature, costing money. Default Lambda concurrency is account-wide (1000) and easy to saturate.
2. **Silent event loss.** A handler that crashes after signature verification but before persisting the resulting state change has acknowledged-but-lost a money event. Stripe will retry on 5xx, but a 200 returned before a partial-failure write is unrecoverable.

## Decision

Two hardening layers, both provisioned in v1:

1. **Reserved concurrency = 10** on the webhook Lambda. Caps throughput a malicious caller can extract to a fixed per-second cost. Honest Stripe traffic for a small SaaS stays well under 10 concurrent.

2. **A dedicated SQS DLQ** is provisioned alongside the webhook (`<app>-<env>-stripe-dlq`), with 14-day retention and SQS-managed encryption. The Lambda has `sqs:SendMessage` on it and the queue URL in its environment. The handler writes any event it cannot process to the DLQ for manual replay.

   Note: Lambda async destinations cannot be used here. Function URL invocations are synchronous; async destinations only fire for event-source-mapped or async-invoked Lambdas. The handler enqueues itself.

## Consequences

- A leaked URL costs at most `10 × Lambda runtime × Stripe rejection rate × duration` until detected. CloudWatch alarms on `Throttles > 0` flag this within minutes.
- Events that fail processing land in the DLQ and can be replayed via a one-off script. A reconciliation runbook lives at `docs/runbooks/stripe-dlq-replay.md` (deferred; written when the DLQ first receives a real message).
- Reserved concurrency reduces the upper bound on legitimate burst capacity. If a Stripe replay ever exceeds 10 concurrent, raise the cap; do not remove it.

## Future: queue-buffered webhook

The robust pattern is webhook → SQS → processor Lambda. The Function URL handler does only signature verification + enqueue, returns 200 immediately, and the processor consumes off the queue with retry + DLQ. Deferred until either (a) a real Stripe burst exceeds the synchronous handler's 15s budget, or (b) the first DLQ incident motivates the additional infra. The DLQ resource provisioned now keeps its identity stable across that future change.
