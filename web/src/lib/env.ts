import { z } from "zod";

const nonEmpty = z.string().trim().min(1);

function required(name: string): string {
  return nonEmpty.parse(process.env[name], {
    path: [name],
  });
}

export function getAwsRegion(): string {
  return process.env.AWS_REGION?.trim() || "us-east-1";
}

export function getPublicOrigin(): string {
  return new URL(required("AUTH_URL")).origin;
}

export function getAuthEnvironment() {
  return {
    clientId: required("AUTH_COGNITO_ID"),
    clientSecret: required("AUTH_COGNITO_SECRET"),
    identityProvider: required("AUTH_COGNITO_IDENTITY_PROVIDER"),
    issuer: required("AUTH_COGNITO_ISSUER"),
    secret: required("AUTH_SECRET"),
  };
}

export function getDeploymentName(): string {
  return required("AGENTFORMATION_DEPLOYMENT");
}

export function getProvisioningStateMachineArn(): string {
  return required("PROVISIONING_STATE_MACHINE_ARN");
}

export function getRegistryTableName(): string {
  return required("USER_REGISTRY_TABLE");
}

export function getUploadBucketName(): string {
  return required("UPLOAD_BUCKET");
}

export function getSessionDocumentName(): string {
  return required("SESSION_DOCUMENT_NAME");
}
