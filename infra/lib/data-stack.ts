import { RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import type { AppConfig } from './config';

export interface DataStackProps extends StackProps {
  config: AppConfig;
}

/**
 * Single-table DynamoDB + tenant artifact bucket.
 * Tables and buckets are retained on stack delete because losing customer
 * data because of a `cdk destroy` typo is not a recoverable mistake.
 */
export class DataStack extends Stack {
  readonly table: dynamodb.Table;
  readonly artifactsBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    this.table = new dynamodb.Table(this, 'Table', {
      tableName: `${props.config.appName}-${props.config.env}`,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.artifactsBucket = new s3.Bucket(this, 'Artifacts', {
      bucketName: `${props.config.appName}-${props.config.env}-artifacts-${this.account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
  }
}
