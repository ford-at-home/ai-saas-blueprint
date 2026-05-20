import type { App } from 'aws-cdk-lib';

export interface AppConfig {
  /** Product slug. Lowercase, hyphens. Prefixes every resource name. */
  appName: string;
  /** Environment suffix on stack names (dev/staging/prod). */
  env: string;
  /** Bedrock model invoked by workflows in this deploy. */
  bedrockModelId: string;
  /**
   * Optional Bedrock Guardrail identifier applied to every workflow
   * invocation. ADR 0007. Absent = no Guardrail (current default).
   */
  bedrockGuardrailId?: string;
  /** Plan assigned to a tenant at signup. */
  defaultPlan: 'free' | 'pro';
  /** Triggers a CloudWatch alarm when monthly spend crosses this (USD). */
  monthlySpendAlarmUsd: number;
  /**
   * CORS allowed origins for the HTTP API. Default `['*']` for local
   * development. Lock down to your real frontend origin before going live.
   */
  allowedOrigins: string[];
}

const SLUG_RE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;

export function loadConfig(app: App): AppConfig {
  const appName = app.node.tryGetContext('app');
  if (!appName) {
    throw new Error(
      'Missing required context: app. Run with `cdk deploy -c app=<slug>`.',
    );
  }
  if (!SLUG_RE.test(appName)) {
    throw new Error(
      `Invalid app slug "${appName}". Use lowercase letters, digits, hyphens; 3-32 chars; start with a letter.`,
    );
  }

  const allowedOriginsRaw = app.node.tryGetContext('allowedOrigins');
  const allowedOrigins: string[] = Array.isArray(allowedOriginsRaw)
    ? allowedOriginsRaw
    : typeof allowedOriginsRaw === 'string'
      ? allowedOriginsRaw.split(',').map((s) => s.trim()).filter(Boolean)
      : ['*'];

  return {
    appName,
    env: app.node.tryGetContext('env') ?? 'dev',
    bedrockModelId:
      app.node.tryGetContext('bedrockModelId') ??
      'anthropic.claude-3-5-sonnet-20241022-v2:0',
    bedrockGuardrailId: app.node.tryGetContext('bedrockGuardrailId') ?? undefined,
    defaultPlan: (app.node.tryGetContext('defaultPlan') ?? 'free') as 'free' | 'pro',
    monthlySpendAlarmUsd: Number(
      app.node.tryGetContext('monthlySpendAlarmUsd') ?? 100,
    ),
    allowedOrigins,
  };
}

/** Standard stack name: `<app>-<env>-<Stack>`. Keeps multi-product, multi-env deploys disjoint in one account. */
export function stackName(config: AppConfig, stack: string): string {
  return `${config.appName}-${config.env}-${stack}`;
}
