# ADR 0006: Workflow output streaming is deferred

- Status: Accepted (deferral); revisit when first chat-UX workflow lands
- Date: 2026-05-20

## Context

v1 uses Step Functions Standard + a Lambda task that calls Bedrock `InvokeModel`. This is batch-only: the Lambda returns once the full model response is available, then the state machine completes. The client polls `GET /workflows/<id>/runs/<runId>` for status.

This is fine for asynchronous workflows (document classification, summarization, batch enrichment). It is wrong for chat UX, where users expect token-by-token streaming.

Two viable upgrade paths exist:

1. **AppSync Subscriptions over WebSockets.** The runner Lambda calls `InvokeModelWithResponseStream` and pushes chunks into AppSync. The frontend subscribes by runId. Adds AppSync to the stack set.
2. **Lambda Function URL response streaming.** The runner Lambda is invoked synchronously, streams Bedrock chunks back through the URL. No new service. Loses the Step Functions audit trail for the streaming path.

## Decision

Defer the streaming path. v1 ships batch-only.

Triggers to revisit:
- A workflow product that is conversational (multi-turn chat) becomes the priority.
- A customer SLA demands first-byte latency under 2s.

When revisited, prefer option 2 (Function URL streaming) unless a frontend exists that already speaks AppSync; the smaller blast radius wins.

## Consequences

- Chat-style products are not built on this blueprint without an ADR superseding this one.
- The `GET /workflows/{id}/runs/{runId}` polling endpoint is the documented client pattern. Frontends must implement backoff.
- Step Functions Standard pricing (per state transition) is acceptable because each run is one transition + a Lambda task. If the streaming path lands, the cost model gets re-evaluated.
