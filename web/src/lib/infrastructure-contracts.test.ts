import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const imageTemplate = readFileSync(
  resolve(import.meta.dirname, "../../../templates/image.yaml"),
  "utf8",
);
const networkTemplate = readFileSync(
  resolve(import.meta.dirname, "../../../templates/network.yaml"),
  "utf8",
);
const checksWorkflow = readFileSync(
  resolve(import.meta.dirname, "../../../.github/workflows/checks.yml"),
  "utf8",
);

describe("network and image template contract", () => {
  it("exports every network value consumed by the image builder", () => {
    expect(imageTemplate).toContain(
      "Fn::ImportValue: !Sub '${NetworkStackName}-PrivateSubnetId'",
    );
    expect(networkTemplate).toContain(
      "Export: { Name: !Sub '${AWS::StackName}-PrivateSubnetId' }",
    );
    expect(imageTemplate).toContain(
      "Fn::ImportValue: !Sub '${NetworkStackName}-BuildSecurityGroupId'",
    );
    expect(networkTemplate).toContain(
      "Export: { Name: !Sub '${AWS::StackName}-BuildSecurityGroupId' }",
    );
  });

  it("packages bunx alongside the pinned Bun binary", () => {
    expect(imageTemplate).toContain(
      "ln -sfn /usr/local/bin/bun /usr/local/bin/bunx",
    );
    expect(imageTemplate.match(/bunx --version/g)).toHaveLength(3);
  });

  it("requires an SSM Agent version that supports environment interpolation", () => {
    expect(imageTemplate).toContain(
      "snap refresh amazon-ssm-agent --channel=latest/stable",
    );
    expect(imageTemplate).toContain(
      'dpkg --compare-versions "$SSM_AGENT_VERSION" ge 3.3.2746.0',
    );
  });

  it("builds and smoke-tests with every fixed command document name", () => {
    const buildStep = checksWorkflow.slice(
      checksWorkflow.indexOf("      - run: bun run build"),
      checksWorkflow.indexOf(
        "      - name: Build and smoke-test the production container",
      ),
    );
    const smokeStep = checksWorkflow.slice(
      checksWorkflow.indexOf(
        "      - name: Build and smoke-test the production container",
      ),
      checksWorkflow.indexOf("\n  infrastructure:"),
    );
    const requiredEnvironment = [
      "AGENTFORMATION_DEPLOYMENT",
      "AUTH_URL",
      "AUTH_COGNITO_ID",
      "AUTH_COGNITO_SECRET",
      "AUTH_COGNITO_IDENTITY_PROVIDER",
      "AUTH_COGNITO_ISSUER",
      "AUTH_SECRET",
      "AWS_REGION",
      "CONTROL_TABLE",
      "PROVISIONING_STATE_MACHINE_ARN",
      "USER_REGISTRY_TABLE",
      "UPLOAD_BUCKET",
      "SESSION_DOCUMENT_NAME",
      "UPLOAD_DELIVERY_DOCUMENT_NAME",
      "OAUTH_RELAY_DOCUMENT_NAME",
    ];

    for (const name of requiredEnvironment) {
      expect(buildStep, `build.${name}`).toMatch(
        new RegExp(`^ {10}${name}:`, "m"),
      );
      expect(smokeStep, `smoke.${name}`).toContain(`--env ${name}=`);
    }
    expect(smokeStep).toContain(
      "docker exec agentformation-web-test id -u | grep -Fx 1001",
    );
    expect(smokeStep).toContain(
      "docker logs agentformation-web-test\n          exit 1",
    );
  });

  it("pins every GitHub Action to a full commit SHA", () => {
    const actions = [...checksWorkflow.matchAll(/^\s+- uses: (\S+)/gm)].map(
      (match) => match[1],
    );
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      expect(action).toMatch(/^[^@]+@[0-9a-f]{40}$/);
    }
  });
});
