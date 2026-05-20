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
  /**
   * Workflow identifiers to provision. In Phase 0 task 5 this list is
   * derived from `workflows/<id>/workflow.yaml` discovery; today it's
   * a single placeholder so the wiring (and SM IAM) is already shaped
   * for multiple machines.
   */
  workflowIds?: string[];
}

/**
 * One Step Functions state machine per workflow id, plus a shared runner
 * Lambda. The state machine's own role carries `bedrock:InvokeModel` so
 * Phase 0 task 5 can switch the runner from Lambda-mediated calls to
 * Step Functions' direct Bedrock SDK integration without re-plumbing IAM.
 */
export class WorkflowStack extends Stack {
  readonly stateMachines: Map<string, sfn.StateMachine>;
  readonly runnerLambda: lambda.IFunction;

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
        ...(props.config.bedrockGuardrailId
          ? { BEDROCK_GUARDRAIL_ID: props.config.bedrockGuardrailId }
          : {}),
      },
      logGroup: new LogGroup(this, 'WorkflowRunnerLogs', {
        logGroupName: `/aws/lambda/${props.config.appName}-${props.config.env}-workflow-runner`,
        retention: RetentionDays.ONE_MONTH,
      }),
    });
    this.runnerLambda = runnerLambda;

    props.table.grantReadWriteData(runnerLambda);
    props.artifactsBucket.grantReadWrite(runnerLambda);
    const bedrockPolicy = new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        `arn:aws:bedrock:${this.region}::foundation-model/${props.config.bedrockModelId}`,
      ],
    });
    runnerLambda.addToRolePolicy(bedrockPolicy);

    this.stateMachines = new Map();
    const workflowIds = props.workflowIds ?? ['example'];
    for (const workflowId of workflowIds) {
      const machine = this.createWorkflowMachine(workflowId, runnerLambda, props);
      // Phase 0 task 5: when SF directly invokes Bedrock, this is the role
      // that needs the permission. Pre-attaching keeps that PR small.
      machine.role.addToPrincipalPolicy(bedrockPolicy);
      this.stateMachines.set(workflowId, machine);
      new CfnOutput(this, `StateMachineArn_${sanitize(workflowId)}`, {
        value: machine.stateMachineArn,
      });
    }
  }

  private createWorkflowMachine(
    workflowId: string,
    runner: lambda.IFunction,
    props: WorkflowStackProps,
  ): sfn.StateMachine {
    const safe = sanitize(workflowId);
    const runTask = new sfnTasks.LambdaInvoke(this, `RunWorkflow_${safe}`, {
      lambdaFunction: runner,
      outputPath: '$.Payload',
    });
    return new sfn.StateMachine(this, `StateMachine_${safe}`, {
      stateMachineName: `${props.config.appName}-${props.config.env}-wf-${safe}`,
      definitionBody: sfn.DefinitionBody.fromChainable(
        runTask.next(new sfn.Succeed(this, `Done_${safe}`)),
      ),
      timeout: Duration.minutes(5),
      tracingEnabled: true,
      logs: {
        destination: new LogGroup(this, `StateMachineLogs_${safe}`, {
          logGroupName: `/aws/vendedlogs/states/${props.config.appName}-${props.config.env}-wf-${safe}`,
          retention: RetentionDays.ONE_MONTH,
        }),
        level: sfn.LogLevel.ALL,
      },
    });
  }
}

/** CDK construct ids and stack names disallow some characters; normalize. */
function sanitize(workflowId: string): string {
  return workflowId.replace(/[^a-zA-Z0-9]/g, '');
}
