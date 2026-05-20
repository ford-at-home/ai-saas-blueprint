#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { ApiStack } from '../lib/api-stack';
import { AuthStack } from '../lib/auth-stack';
import { BillingStack } from '../lib/billing-stack';
import { loadConfig, stackName } from '../lib/config';
import { DataStack } from '../lib/data-stack';
import { WorkflowStack } from '../lib/workflow-stack';

const app = new App();
const config = loadConfig(app);

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

const data = new DataStack(app, stackName(config, 'Data'), { config, env });
const auth = new AuthStack(app, stackName(config, 'Auth'), { config, env });

new ApiStack(app, stackName(config, 'Api'), {
  config,
  env,
  userPool: auth.userPool,
  userPoolClient: auth.userPoolClient,
  table: data.table,
});

new WorkflowStack(app, stackName(config, 'Workflow'), {
  config,
  env,
  table: data.table,
  artifactsBucket: data.artifactsBucket,
});

new BillingStack(app, stackName(config, 'Billing'), {
  config,
  env,
  table: data.table,
});

app.synth();
