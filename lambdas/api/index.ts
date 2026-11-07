import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';

/**
 * Phase 0 placeholder. Real route handlers (POST /workflows/{id}/runs, etc.)
 * land in Phase 0 task 4. Today this returns the authenticated tenant context
 * so the wiring is verifiable from a curl + JWT.
 */
export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  const claims = event.requestContext.authorizer?.jwt?.claims ?? {};
  const tenantId = String(claims['custom:tenant_id'] ?? '');
  const userId = String(claims.sub ?? '');

  if (!tenantId) {
    return json(403, { error: 'missing_tenant_id_claim' });
  }

  return json(200, {
    route: `${event.requestContext.http.method} ${event.requestContext.http.path}`,
    tenantId,
    userId,
    app: process.env.APP_NAME,
    env: process.env.ENV,
    note: 'placeholder handler; see docs/phase-0-tasks.md task 4',
  });
};

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}
