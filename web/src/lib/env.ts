import { z } from "zod";

const nonEmpty = z.string().trim().min(1);
const awsRegion = z
  .string()
  .regex(/^[a-z]{2}(?:-[a-z0-9]+)+-[0-9]+$/, "AWS_REGION is invalid");
const bucketName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/, "UPLOAD_BUCKET is invalid");
const deploymentName = z
  .string()
  .regex(
    /^(?!.*-runtime-)[a-z][a-z0-9-]{2,31}$/,
    "AGENTFORMATION_DEPLOYMENT is invalid",
  );
const documentName = z
  .string()
  .regex(/^[A-Za-z0-9_.-]{3,128}$/, "SSM document name is invalid");
const tableName = z
  .string()
  .regex(/^[A-Za-z0-9_.-]{3,255}$/, "DynamoDB table name is invalid");
const stateMachineArn = z
  .string()
  .regex(
    /^arn:(aws|aws-us-gov|aws-cn):states:([a-z]{2}(?:-[a-z0-9]+)+-[0-9]+):[0-9]{12}:stateMachine:[A-Za-z0-9_+=,.@-]{1,80}$/,
    "PROVISIONING_STATE_MACHINE_ARN is invalid",
  );

function required(name: string): string {
  return nonEmpty.parse(process.env[name], {
    path: [name],
  });
}

export function getAwsRegion(): string {
  return awsRegion.parse(required("AWS_REGION"));
}

export function getPublicOrigin(): string {
  const url = new URL(required("AUTH_URL"));
  const isLoopbackDevelopmentOrigin =
    process.env.NODE_ENV === "development" &&
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !isLoopbackDevelopmentOrigin) {
    throw new Error("AUTH_URL must use HTTPS");
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("AUTH_URL must contain only an origin");
  }
  return url.origin;
}

export function getAuthEnvironment() {
  const clientSecret = required("AUTH_COGNITO_SECRET");
  if (clientSecret === "pending-deploy") {
    throw new Error("Cognito client secret has not been configured");
  }

  const identityProvider = required("AUTH_COGNITO_IDENTITY_PROVIDER");
  if (identityProvider !== "IdentityCenter") {
    throw new Error("Only the IdentityCenter provider is supported");
  }

  const issuer = new URL(required("AUTH_COGNITO_ISSUER"));
  const region = getAwsRegion();
  const awsUrlSuffix = region.startsWith("cn-")
    ? "amazonaws.com.cn"
    : "amazonaws.com";
  if (
    issuer.protocol !== "https:" ||
    issuer.hostname !== `cognito-idp.${region}.${awsUrlSuffix}` ||
    issuer.port ||
    issuer.username ||
    issuer.password ||
    !/^\/[A-Za-z0-9_-]+$/.test(issuer.pathname) ||
    issuer.search ||
    issuer.hash
  ) {
    throw new Error(
      "AUTH_COGNITO_ISSUER must identify this region's Cognito user pool",
    );
  }

  const secret = required("AUTH_SECRET");
  if (new TextEncoder().encode(secret).byteLength < 32) {
    throw new Error("AUTH_SECRET must contain at least 32 bytes");
  }

  return {
    clientId: required("AUTH_COGNITO_ID"),
    clientSecret,
    identityProvider,
    issuer: issuer.href.replace(/\/$/, ""),
    secret,
  };
}

export function getDeploymentName(): string {
  return deploymentName.parse(required("AGENTFORMATION_DEPLOYMENT"));
}

export function getProvisioningStateMachineArn(): string {
  const value = stateMachineArn.parse(
    required("PROVISIONING_STATE_MACHINE_ARN"),
  );
  const [, partition, , region] = value.split(":");
  const configuredRegion = getAwsRegion();
  const expectedPartition = configuredRegion.startsWith("cn-")
    ? "aws-cn"
    : configuredRegion.startsWith("us-gov-")
      ? "aws-us-gov"
      : "aws";
  if (region !== configuredRegion || partition !== expectedPartition) {
    throw new Error(
      "PROVISIONING_STATE_MACHINE_ARN must match AWS_REGION and its partition",
    );
  }
  return value;
}

export function getRegistryTableName(): string {
  return tableName.parse(required("USER_REGISTRY_TABLE"));
}

export function getControlTableName(): string {
  return tableName.parse(required("CONTROL_TABLE"));
}

export function getUploadBucketName(): string {
  return bucketName.parse(required("UPLOAD_BUCKET"));
}

export function getSessionDocumentName(): string {
  return documentName.parse(required("SESSION_DOCUMENT_NAME"));
}

export function getUploadDeliveryDocumentName(): string {
  return documentName.parse(required("UPLOAD_DELIVERY_DOCUMENT_NAME"));
}

export function getOAuthRelayDocumentName(): string {
  return documentName.parse(required("OAUTH_RELAY_DOCUMENT_NAME"));
}

export function validateApplicationEnvironment(): void {
  getPublicOrigin();
  getAuthEnvironment();
  getDeploymentName();
  getProvisioningStateMachineArn();
  getRegistryTableName();
  getControlTableName();
  getUploadBucketName();
  getSessionDocumentName();
  getUploadDeliveryDocumentName();
  getOAuthRelayDocumentName();
}
