import * as path from 'node:path';
import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as sfnTasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import type { Construct } from 'constructs';
import type { AppConfig } from './config';

export interface WorkflowStackProps extends StackProps {
  config: AppConfig;
  table: dynamodb.Table;
  artifactsBucket: s3.Bucket;
}

/**
 * v1 workflow: a single Step Functions state machine that invokes the
 * configured Bedrock model. Real per-workflow state machines (loaded from
 * workflows/<id>/workflow.yaml) land in Phase 0 task 5; this is a placeholder
 * machine that proves the wiring + IAM.
 */
export class WorkflowStack extends Stack {
  readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: WorkflowStackProps) {
    super(scope, id, props);

    const runnerLambda = new NodejsFunction(this, 'WorkflowRunner', {
      functionName: `${props.config.appName}-${props.config.env}-workflow-runner`,
      entry: path.join(__dirname, '../../lambdas/workflow-runner/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: Duration.minutes(5),
      memorySize: 1024,
      architecture: lambda.Architecture.ARM_64,
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        TABLE_NAME: props.table.tableName,
        ARTIFACTS_BUCKET: props.artifactsBucket.bucketName,
        BEDROCK_MODEL_ID: props.config.bedrockModelId,
      },
      logGroup: new LogGroup(this, 'WorkflowRunnerLogs', {
        logGroupName: `/aws/lambda/${props.config.appName}-${props.config.env}-workflow-runner`,
        retention: RetentionDays.ONE_MONTH,
      }),
    });

    props.table.grantReadWriteData(runnerLambda);
    props.artifactsBucket.grantReadWrite(runnerLambda);
    runnerLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [`arn:aws:bedrock:${this.region}::foundation-model/${props.config.bedrockModelId}`],
    }));

    const runTask = new sfnTasks.LambdaInvoke(this, 'RunWorkflow', {
      lambdaFunction: runnerLambda,
      outputPath: '$.Payload',
    });

    const definition = runTask.next(new sfn.Succeed(this, 'Done'));

    this.stateMachine = new sfn.StateMachine(this, 'StateMachine', {
      stateMachineName: `${props.config.appName}-${props.config.env}-workflow`,
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: Duration.minutes(5),
      tracingEnabled: true,
      logs: {
        destination: new LogGroup(this, 'StateMachineLogs', {
          logGroupName: `/aws/vendedlogs/states/${props.config.appName}-${props.config.env}-workflow`,
          retention: RetentionDays.ONE_MONTH,
        }),
        level: sfn.LogLevel.ALL,
      },
    });

    new CfnOutput(this, 'StateMachineArn', { value: this.stateMachine.stateMachineArn });
  }
}
