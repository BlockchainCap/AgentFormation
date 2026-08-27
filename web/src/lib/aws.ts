import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { SFNClient } from "@aws-sdk/client-sfn";
import { SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { getAwsRegion } from "./env";

const CONNECTION_TIMEOUT_MS = 3_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 2;

// Session mutations can perform two sequential AWS calls after acquiring their
// lease. Keep the lease well beyond both request budgets and retry backoff.
export const AWS_MUTATION_GUARD_TTL_SECONDS = 2 * 60;

// Upload delivery and OAuth relay include a bounded remote command plus
// staging cleanup. Keep their in-request cross-instance lease beyond that full
// budget. A separate upload claim or OAuth relay lease remains after an
// uncertain command outcome to prevent replay until its own TTL.
export const AWS_REMOTE_COMMAND_GUARD_TTL_SECONDS = 10 * 60;

function clientConfiguration() {
  return {
    region: getAwsRegion(),
    maxAttempts: MAX_ATTEMPTS,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: CONNECTION_TIMEOUT_MS,
      requestTimeout: REQUEST_TIMEOUT_MS,
    }),
  };
}

let cloudFormationClient: CloudFormationClient | undefined;
let documentClient: DynamoDBDocumentClient | undefined;
let s3Client: S3Client | undefined;
let sfnClient: SFNClient | undefined;
let ssmClient: SSMClient | undefined;

export function getCloudFormationClient(): CloudFormationClient {
  cloudFormationClient ??= new CloudFormationClient(clientConfiguration());
  return cloudFormationClient;
}

export function getDocumentClient(): DynamoDBDocumentClient {
  documentClient ??= DynamoDBDocumentClient.from(
    new DynamoDBClient(clientConfiguration()),
    { marshallOptions: { removeUndefinedValues: true } },
  );
  return documentClient;
}

export function getS3Client(): S3Client {
  s3Client ??= new S3Client(clientConfiguration());
  return s3Client;
}

export function getSfnClient(): SFNClient {
  sfnClient ??= new SFNClient(clientConfiguration());
  return sfnClient;
}

export function getSsmClient(): SSMClient {
  ssmClient ??= new SSMClient(clientConfiguration());
  return ssmClient;
}
