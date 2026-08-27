import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const template = readFileSync(
  resolve(import.meta.dirname, "../../../templates/web.yaml"),
  "utf8",
);

describe("web template", () => {
  it("derives the trusted Cognito issuer from this account and region", () => {
    expect(template).not.toContain("  CognitoIssuer:");
    expect(template).toContain("  UserPoolId:");
    expect(template).toContain(
      'Value: !Sub "https://cognito-idp.${AWS::Region}.${AWS::URLSuffix}/${UserPoolId}"',
    );
  });

  it("requires an HTTPS public origin", () => {
    expect(template).toContain(
      'AllowedPattern: "^https://[A-Za-z0-9.-]+(?::[0-9]{1,5})?$"',
    );
  });

  it("constrains every operator value used in an IAM resource", () => {
    expect(template).toContain(
      'AllowedPattern: "^arn:[A-Za-z0-9-]+:secretsmanager:',
    );
    expect(template).toContain(
      'AllowedPattern: "^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$"',
    );
    expect(template).toContain('AllowedPattern: "^arn:[A-Za-z0-9-]+:states:');
    expect(template).toContain(
      '!Sub "arn:${AWS::Partition}:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess"',
    );
  });

  it("deploys an ECR digest and only fixed runtime command documents", () => {
    expect(template).toContain("@sha256:[a-f0-9]{64}$");
    expect(template).toContain("${UploadDeliveryDocumentName}");
    expect(template).toContain("${OAuthRelayDocumentName}");
    expect(template).not.toContain("AWS-RunShellScript");
  });

  it("constrains every deployment-selected session and command document", () => {
    const parameters = template.slice(
      template.indexOf("Parameters:"),
      template.indexOf("Resources:"),
    );
    for (const name of [
      "TerminalSessionDocumentName",
      "UploadDeliveryDocumentName",
      "OAuthRelayDocumentName",
    ]) {
      expect(parameters).toContain(
        `  ${name}:\n    Type: String\n    AllowedPattern: "^[A-Za-z0-9_.-]{3,128}$"`,
      );
    }
  });

  it("requires access to the fixed session document for every runtime session", () => {
    const sessionPolicy = template.slice(
      template.indexOf("        - PolicyName: ManageBrowserSessions"),
      template.indexOf("        - PolicyName: ManageUploadStaging"),
    );
    const instancePermission = template.slice(
      template.indexOf("              - Sid: StartTaggedRuntimeSession"),
      template.indexOf("              - Sid: UseTerminalDocument"),
    );
    const documentPermission = template.slice(
      template.indexOf("              - Sid: UseTerminalDocument"),
      template.indexOf("              - Sid: RunUploadCommand"),
    );

    expect(instancePermission).toContain(
      'Bool:\n                    "ssm:SessionDocumentAccessCheck": true',
    );
    expect(documentPermission).toContain("${TerminalSessionDocumentName}");
    expect(documentPermission).not.toContain("SSM-SessionManagerRunShell");
    expect(documentPermission).not.toContain('Resource: "*"');
    expect(sessionPolicy.match(/Action: ssm:StartSession/g)).toHaveLength(2);
    expect(sessionPolicy.match(/ssm:SessionDocumentAccessCheck/g)).toHaveLength(
      1,
    );
    expect(sessionPolicy.match(/Action: ssm:SendCommand/g)).toHaveLength(2);
    expect(sessionPolicy).toContain(
      'document/${UploadDeliveryDocumentName}"\n                  - !Sub "arn:${AWS::Partition}:ssm:${AWS::Region}:${AWS::AccountId}:document/${OAuthRelayDocumentName}"',
    );
  });
});
