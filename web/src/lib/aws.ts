import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { getAwsRegion } from "./env";

let documentClient: DynamoDBDocumentClient | undefined;
let s3Client: S3Client | undefined;
let ssmClient: SSMClient | undefined;

export function getDocumentClient(): DynamoDBDocumentClient {
  documentClient ??= DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: getAwsRegion() }),
    { marshallOptions: { removeUndefinedValues: true } },
  );
  return documentClient;
}

export function getS3Client(): S3Client {
  s3Client ??= new S3Client({ region: getAwsRegion() });
  return s3Client;
}

export function getSsmClient(): SSMClient {
  ssmClient ??= new SSMClient({ region: getAwsRegion() });
  return ssmClient;
}
