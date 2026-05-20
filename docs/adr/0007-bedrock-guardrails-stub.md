# ADR 0007: Bedrock Guardrails — wired but optional

- Status: Accepted
- Date: 2026-05-20

## Context

CLAUDE.md §8 lists Bedrock Guardrails as deferred until the first compliance review demands them. That defers the *creation* of Guardrails resources, which is the right call: they cost money, take tuning, and shouldn't be sprayed across every product.

It does not defer the *integration shim*. Once a customer brings a Guardrail ARN, plumbing it through should be a configuration change, not a code change.

## Decision

`AppConfig` includes an optional `bedrockGuardrailId` field. When set:

- The workflow runner Lambda receives `BEDROCK_GUARDRAIL_ID` as an environment variable.
- Every `InvokeModel` call passes `guardrailIdentifier` + `guardrailVersion`.

When unset:

- The env var is not added to the Lambda (so its absence is obvious in CloudWatch).
- Bedrock calls run without Guardrails. This is the v1 default.

Set the value via CDK context:

```
cdk deploy -c app=<slug> -c bedrockGuardrailId=arn:aws:bedrock:...:guardrail/abc:1
```

## Consequences

- A customer who requires Guardrails can be onboarded with a redeploy, not a code change.
- The runner Lambda's Bedrock policy needs `bedrock:ApplyGuardrail` added when this is first turned on. That's a one-line stack edit; not adding it preemptively keeps the policy minimal.
- Guardrail violations produce a Bedrock error that the runner must classify and persist on the `RUN#` row. The classification logic is part of Phase 0 task 5.
