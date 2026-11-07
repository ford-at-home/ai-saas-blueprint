# ADR 0008: Typed API clients via zod schemas

- Status: Proposed; pending Phase 0 task 4
- Date: 2026-05-20

## Context

The HTTP API has five routes (Phase 0 task 4). When the frontend lands (Phase 1) it will hand-build request/response types and they will drift from the Lambda handlers. The same drift will happen between the API and any internal admin tooling, and between API contracts across product slugs that share workflow types.

OpenAPI generation from CDK constructs is awkward; the route declarations in `api-stack.ts` are not the right source of truth (they only have path + method).

## Decision

When the API handlers are implemented (Phase 0 task 4), each route defines its request/response shapes as zod schemas in `packages/api-schema` (new workspace). The Lambda handlers validate inputs with `schema.parse(event.body)`, and an `npm run openapi` script emits an OpenAPI 3.1 document from the schemas.

```ts
// packages/api-schema/src/workflows.ts
export const StartRunRequest = z.object({
  input: z.record(z.unknown()),
});
export const StartRunResponse = z.object({
  runId: z.string(),
  status: z.literal('pending'),
});
```

Frontends import the inferred TypeScript types directly. External SDKs (deferred) generate from the OpenAPI document.

## Consequences

- One source of truth for the API surface. Drift is a type error, not a runtime bug.
- zod is a small dependency (~10 kB minified) and already idiomatic for Lambda input validation.
- Schemas live in a package, not in the handlers, so they are importable from CDK (for API Gateway request validation) and from the frontend.
- This ADR is "Proposed" — accept it when Phase 0 task 4 lands, or reject and replace with a different pattern at that time.
