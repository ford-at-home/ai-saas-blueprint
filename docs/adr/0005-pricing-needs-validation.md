# ADR 0005: Pricing needs validation against real workloads

- Status: Open question; revisit before Phase 1 launch
- Date: 2026-05-20
- Depends on: ADR 0003

## Context

The Pro plan (ADR 0003) is $49/month for 5,000 workflow runs. That implies a per-run unit revenue of $0.0098. The default model is Claude 3.5 Sonnet, billed on Bedrock at $3 per 1M input tokens and $15 per 1M output tokens (as of 2026-05).

A workflow that produces 2,000 output tokens against a 1,000-token prompt costs `(1000/1e6)*3 + (2000/1e6)*15 = $0.033`. At that profile, Bedrock alone consumes ~3.4× the per-run revenue. CloudWatch + Step Functions + Lambda + DynamoDB costs are additional.

This is a v1 paywall placeholder, not a defended business model.

## Decision

Before Phase 1 (frontend launch), do the following in order:

1. **Measure** the token profile of the first real workflow (`example-chatbot` or its replacement) across ~50 runs spanning short and long inputs.
2. **Compute** unit cost per run including Bedrock + Step Functions Standard (per-state-transition) + Lambda + DDB writes + CloudWatch.
3. **Choose** one of:
   - Raise Pro to a price that yields ≥50% gross margin at typical run sizes.
   - Switch from "runs/month" to "tokens/month" so cost and revenue scale together. This is the Marketplace-style metered pricing path; requires Stripe Meters and an `EntitlementProvider` revision but the interface (ADR 0002) already permits it.
   - Cap output tokens per run at a value where the run-based plan pencils.

Do not publish prices on a marketing site until step 3 lands.

## Consequences

- Free tier (50 runs/mo) is a marketing cost regardless of plan shape. Budget for it.
- A token-metered Pro plan is the most flexible and aligns incentives, but it complicates the UX ("how much does one chat cost?"). Run-based is simpler to explain; choose run-based if the run size can be controlled by product design (e.g., bounded output tokens).
- If output-token bounding is the answer, the workflow YAML (`workflows/<id>/workflow.yaml`) should make `maxOutputTokens` a required field.
