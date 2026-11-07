import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';

/**
 * Phase 0 placeholder for the Stripe webhook (ADR 0003).
 *
 * Real implementation (Phase 0 task 6) must do, in this order, BEFORE any DB writes:
 *   1. Fetch STRIPE_WEBHOOK_SECRET from Secrets Manager (cached per warm container).
 *   2. Verify the Stripe-Signature header against the raw body. If invalid: return 401.
 *   3. Reject events with a timestamp older than 5 minutes (replay window).
 *   4. Idempotency: write `STRIPE_EVENT#<id>` with attribute_not_exists(SK).
 *      If condition fails, return 200 (already processed).
 *   5. Switch on event.type and update Tenants accordingly.
 *
 * Until then this returns 501 so it's obvious nothing is hooked up.
 */
export const handler = async (
  event: LambdaFunctionURLEvent,
): Promise<LambdaFunctionURLResult> => {
  const signature = event.headers['stripe-signature'];
  if (!signature) {
    return { statusCode: 400, body: JSON.stringify({ error: 'missing_signature' }) };
  }

  console.log(JSON.stringify({
    msg: 'stripe_webhook_received_but_not_yet_implemented',
    sigPresent: true,
    contentType: event.headers['content-type'],
    bodyLength: event.body?.length ?? 0,
    secretArn: process.env.STRIPE_SECRET_ARN,
    tableName: process.env.TABLE_NAME,
  }));

  return {
    statusCode: 501,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ error: 'not_implemented', see: 'docs/phase-0-tasks.md#6-billing' }),
  };
};
