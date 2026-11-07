import * as path from 'node:path';
import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
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
 *
 * Hardening (ADR 0009):
 *  - Reserved concurrency caps cost-DoS blast radius if the URL leaks.
 *  - A DLQ is provisioned (and its ARN handed to the Lambda) so the
 *    handler can deposit events it cannot process for later replay.
 *    Lambda destinations cannot be used here because Function URL
 *    invocations are synchronous; the handler writes to the queue itself
 *    when it gives up on an event.
 */
export class BillingStack extends Stack {
  readonly webhookUrl: lambda.FunctionUrl;
  readonly stripeSecret: secrets.Secret;
  readonly webhookDlq: sqs.Queue;

  constructor(scope: Construct, id: string, props: BillingStackProps) {
    super(scope, id, props);

    this.stripeSecret = new secrets.Secret(this, 'StripeSecret', {
      secretName: `${props.config.appName}/${props.config.env}/stripe`,
      description: 'Stripe API secret key + webhook signing secret. Set via aws secretsmanager put-secret-value.',
      secretObjectValue: {},
    });

    this.webhookDlq = new sqs.Queue(this, 'StripeWebhookDlq', {
      queueName: `${props.config.appName}-${props.config.env}-stripe-dlq`,
      retentionPeriod: Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
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
      reservedConcurrentExecutions: 10,
      environment: {
        TABLE_NAME: props.table.tableName,
        STRIPE_SECRET_ARN: this.stripeSecret.secretArn,
        STRIPE_DLQ_URL: this.webhookDlq.queueUrl,
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
    this.webhookDlq.grantSendMessages(webhookHandler);

    this.webhookUrl = webhookHandler.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    });

    new CfnOutput(this, 'StripeWebhookUrl', { value: this.webhookUrl.url });
    new CfnOutput(this, 'StripeSecretArn', { value: this.stripeSecret.secretArn });
    new CfnOutput(this, 'StripeWebhookDlqUrl', { value: this.webhookDlq.queueUrl });
  }
}
