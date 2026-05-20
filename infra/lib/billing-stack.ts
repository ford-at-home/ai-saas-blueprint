import * as path from 'node:path';
import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';
import type { AppConfig } from './config';

export interface BillingStackProps extends StackProps {
  config: AppConfig;
  table: dynamodb.Table;
}

/**
 * Stripe-only paywall (ADR 0003). Single Lambda exposed via Function URL.
 * No API Gateway: Stripe doesn't need one, and signature verification is
 * the auth boundary.
 */
export class BillingStack extends Stack {
  readonly webhookUrl: lambda.FunctionUrl;
  readonly stripeSecret: secrets.Secret;

  constructor(scope: Construct, id: string, props: BillingStackProps) {
    super(scope, id, props);

    this.stripeSecret = new secrets.Secret(this, 'StripeSecret', {
      secretName: `${props.config.appName}/${props.config.env}/stripe`,
      description: 'Stripe API secret key + webhook signing secret. Set via aws secretsmanager put-secret-value.',
      secretObjectValue: {},
    });

    const webhookHandler = new NodejsFunction(this, 'StripeWebhook', {
      functionName: `${props.config.appName}-${props.config.env}-stripe-webhook`,
      entry: path.join(__dirname, '../../lambdas/stripe-webhook/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: Duration.seconds(15),
      memorySize: 512,
      architecture: lambda.Architecture.ARM_64,
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        TABLE_NAME: props.table.tableName,
        STRIPE_SECRET_ARN: this.stripeSecret.secretArn,
        APP_NAME: props.config.appName,
        ENV: props.config.env,
      },
      logGroup: new LogGroup(this, 'StripeWebhookLogs', {
        logGroupName: `/aws/lambda/${props.config.appName}-${props.config.env}-stripe-webhook`,
        retention: RetentionDays.ONE_MONTH,
      }),
    });

    props.table.grantReadWriteData(webhookHandler);
    this.stripeSecret.grantRead(webhookHandler);

    this.webhookUrl = webhookHandler.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    });

    new CfnOutput(this, 'StripeWebhookUrl', { value: this.webhookUrl.url });
    new CfnOutput(this, 'StripeSecretArn', { value: this.stripeSecret.secretArn });
  }
}
