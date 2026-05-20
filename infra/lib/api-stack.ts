import * as path from 'node:path';
import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2Auth from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as apigwv2Int from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type * as cognito from 'aws-cdk-lib/aws-cognito';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import type { AppConfig } from './config';

export interface ApiStackProps extends StackProps {
  config: AppConfig;
  userPool: cognito.UserPool;
  userPoolClient: cognito.UserPoolClient;
  table: dynamodb.Table;
}

/**
 * HTTP API + Cognito JWT authorizer + one handler Lambda.
 * Real route handlers land in Phase 0 task 4; today's stub proves wiring.
 */
export class ApiStack extends Stack {
  readonly httpApi: apigwv2.HttpApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const apiHandler = new NodejsFunction(this, 'ApiHandler', {
      functionName: `${props.config.appName}-${props.config.env}-api`,
      entry: path.join(__dirname, '../../lambdas/api/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: Duration.seconds(15),
      memorySize: 512,
      architecture: lambda.Architecture.ARM_64,
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        TABLE_NAME: props.table.tableName,
        APP_NAME: props.config.appName,
        ENV: props.config.env,
        DEFAULT_PLAN: props.config.defaultPlan,
      },
      logGroup: new LogGroup(this, 'ApiHandlerLogs', {
        logGroupName: `/aws/lambda/${props.config.appName}-${props.config.env}-api`,
        retention: RetentionDays.ONE_MONTH,
      }),
    });

    props.table.grantReadWriteData(apiHandler);

    const authorizer = new apigwv2Auth.HttpJwtAuthorizer(
      'JwtAuthorizer',
      `https://cognito-idp.${this.region}.amazonaws.com/${props.userPool.userPoolId}`,
      {
        jwtAudience: [props.userPoolClient.userPoolClientId],
        identitySource: ['$request.header.Authorization'],
      },
    );

    this.httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: `${props.config.appName}-${props.config.env}-api`,
      defaultAuthorizer: authorizer,
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [apigwv2.CorsHttpMethod.ANY],
        allowHeaders: ['authorization', 'content-type'],
      },
    });

    const integration = new apigwv2Int.HttpLambdaIntegration('ApiInt', apiHandler);

    for (const route of ['GET /tenants/me', 'GET /workflows', 'POST /workflows/{workflowId}/runs', 'GET /workflows/{workflowId}/runs/{runId}', 'POST /billing/checkout']) {
      const [method, p] = route.split(' ');
      this.httpApi.addRoutes({
        path: p,
        methods: [method as apigwv2.HttpMethod],
        integration,
      });
    }

    new CfnOutput(this, 'ApiUrl', { value: this.httpApi.apiEndpoint });
  }
}
