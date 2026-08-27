import { afterEach, describe, expect, it, vi } from "vitest";
import { getPublicOrigin, validateApplicationEnvironment } from "./env";

const REQUIRED_ENVIRONMENT = {
  AWS_REGION: "us-west-2",
  AUTH_COGNITO_ID: "client-id",
  AUTH_COGNITO_SECRET: "client-secret",
  AUTH_COGNITO_IDENTITY_PROVIDER: "IdentityCenter",
  AUTH_COGNITO_ISSUER:
    "https://cognito-idp.us-west-2.amazonaws.com/us-west-2_example",
  AUTH_SECRET: "a-long-generated-session-secret-with-48-bytes-total",
  AGENTFORMATION_DEPLOYMENT: "agentformation",
  PROVISIONING_STATE_MACHINE_ARN:
    "arn:aws:states:us-west-2:111122223333:stateMachine:agentformation",
  USER_REGISTRY_TABLE: "agentformation-users",
  CONTROL_TABLE: "agentformation-control",
  UPLOAD_BUCKET: "agentformation-uploads",
  SESSION_DOCUMENT_NAME: "agentformation-terminal",
  UPLOAD_DELIVERY_DOCUMENT_NAME: "agentformation-upload-delivery",
  OAUTH_RELAY_DOCUMENT_NAME: "agentformation-oauth-relay",
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getPublicOrigin", () => {
  it("accepts an HTTPS public origin", () => {
    vi.stubEnv("AUTH_URL", "https://agentformation.example/");
    expect(getPublicOrigin()).toBe("https://agentformation.example");
  });

  it("rejects a public URL with path, query, credentials, or fragment", () => {
    for (const value of [
      "https://agentformation.example/path",
      "https://agentformation.example/?mode=unsafe",
      "https://user@agentformation.example/",
      "https://agentformation.example/#fragment",
    ]) {
      vi.stubEnv("AUTH_URL", value);
      expect(() => getPublicOrigin()).toThrow(
        "AUTH_URL must contain only an origin",
      );
    }
  });

  it("rejects a production HTTP origin", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_URL", "http://agentformation.example");
    expect(() => getPublicOrigin()).toThrow("AUTH_URL must use HTTPS");
  });

  it("allows HTTP only for local development", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AUTH_URL", "http://127.0.0.1:3000");
    expect(getPublicOrigin()).toBe("http://127.0.0.1:3000");
  });

  it("rejects HTTP when development mode is absent or the host is not loopback", () => {
    vi.stubEnv("NODE_ENV", undefined);
    vi.stubEnv("AUTH_URL", "http://127.0.0.1:3000");
    expect(() => getPublicOrigin()).toThrow("AUTH_URL must use HTTPS");

    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AUTH_URL", "http://agentformation.example");
    expect(() => getPublicOrigin()).toThrow("AUTH_URL must use HTTPS");
  });
});

describe("validateApplicationEnvironment", () => {
  it("checks every setting needed by authenticated routes", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_URL", "https://agentformation.example");
    for (const [name, value] of Object.entries(REQUIRED_ENVIRONMENT)) {
      vi.stubEnv(name, value);
    }

    expect(() => validateApplicationEnvironment()).not.toThrow();
  });

  it.each([
    ["AWS_REGION", "US-WEST-2", "AWS_REGION is invalid"],
    [
      "AGENTFORMATION_DEPLOYMENT",
      "demo-runtime-admin",
      "AGENTFORMATION_DEPLOYMENT is invalid",
    ],
    ["UPLOAD_BUCKET", "uploads.example", "UPLOAD_BUCKET is invalid"],
    ["SESSION_DOCUMENT_NAME", "bad/name", "SSM document name is invalid"],
    [
      "UPLOAD_DELIVERY_DOCUMENT_NAME",
      "bad/name",
      "SSM document name is invalid",
    ],
    ["OAUTH_RELAY_DOCUMENT_NAME", "bad/name", "SSM document name is invalid"],
    ["USER_REGISTRY_TABLE", "x", "DynamoDB table name is invalid"],
    ["CONTROL_TABLE", "x", "DynamoDB table name is invalid"],
    [
      "PROVISIONING_STATE_MACHINE_ARN",
      "arn:aws:states:us-east-1:111122223333:stateMachine:agentformation",
      "PROVISIONING_STATE_MACHINE_ARN must match AWS_REGION and its partition",
    ],
    [
      "PROVISIONING_STATE_MACHINE_ARN",
      "not-an-arn",
      "PROVISIONING_STATE_MACHINE_ARN is invalid",
    ],
  ])("rejects malformed %s", (name, value, message) => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_URL", "https://agentformation.example");
    for (const [environmentName, environmentValue] of Object.entries(
      REQUIRED_ENVIRONMENT,
    )) {
      vi.stubEnv(environmentName, environmentValue);
    }
    vi.stubEnv(name, value);

    expect(() => validateApplicationEnvironment()).toThrow(message);
  });

  it.each(["AUTH_URL", ...Object.keys(REQUIRED_ENVIRONMENT)])(
    "rejects a missing %s setting at its named boundary",
    (missingName) => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("AUTH_URL", "https://agentformation.example");
      for (const [name, value] of Object.entries(REQUIRED_ENVIRONMENT)) {
        vi.stubEnv(name, value);
      }
      vi.stubEnv(missingName, undefined);

      expect(() => validateApplicationEnvironment()).toThrow(missingName);
    },
  );

  it("rejects a weak secret or a login provider other than Identity Center", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_URL", "https://agentformation.example");
    for (const [name, value] of Object.entries(REQUIRED_ENVIRONMENT)) {
      vi.stubEnv(name, value);
    }

    vi.stubEnv("AUTH_SECRET", "too-short");
    expect(() => validateApplicationEnvironment()).toThrow(
      "AUTH_SECRET must contain at least 32 bytes",
    );
    vi.stubEnv("AUTH_SECRET", REQUIRED_ENVIRONMENT.AUTH_SECRET);
    vi.stubEnv("AUTH_COGNITO_IDENTITY_PROVIDER", "COGNITO");
    expect(() => validateApplicationEnvironment()).toThrow(
      "Only the IdentityCenter provider is supported",
    );
  });

  it("rejects a Cognito issuer outside the configured AWS region", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_URL", "https://agentformation.example");
    for (const [name, value] of Object.entries(REQUIRED_ENVIRONMENT)) {
      vi.stubEnv(name, value);
    }

    vi.stubEnv(
      "AUTH_COGNITO_ISSUER",
      "https://issuer.example/us-west-2_example",
    );
    expect(() => validateApplicationEnvironment()).toThrow(
      "AUTH_COGNITO_ISSUER must identify this region's Cognito user pool",
    );
  });

  it("reports the identity bootstrap placeholder as not ready", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_URL", "https://agentformation.example");
    for (const [name, value] of Object.entries(REQUIRED_ENVIRONMENT)) {
      vi.stubEnv(name, value);
    }
    vi.stubEnv("AUTH_COGNITO_SECRET", "pending-deploy");

    expect(() => validateApplicationEnvironment()).toThrow(
      "Cognito client secret has not been configured",
    );
  });
});
