import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const template = readFileSync(
  resolve(import.meta.dirname, "../../../templates/provisioning.yaml"),
  "utf8",
);
const stateMachineRole = template.slice(
  template.indexOf("  ProvisioningStateMachineRole:"),
  template.indexOf("  RuntimeProvisioningStateMachine:"),
);

describe("runtime provisioning template", () => {
  it("lets only the provisioning job read the reviewed runtime template", () => {
    expect(stateMachineRole).toContain(
      "PolicyName: ReadReviewedRuntimeTemplate",
    );
    expect(stateMachineRole).toContain("Action: s3:GetObject");
    expect(stateMachineRole).toContain(
      'Resource: !Sub "arn:${AWS::Partition}:s3:::${RuntimeTemplateBucket}/${RuntimeTemplateKey}"',
    );
  });

  it("limits runtime stack creation to the reviewed template and role", () => {
    expect(stateMachineRole).toContain(
      "cloudformation:RoleArn: !GetAtt RuntimeCloudFormationRole.Arn",
    );
    expect(stateMachineRole).toContain(
      "cloudformation:TemplateUrl: !Ref RuntimeTemplateUrl",
    );
  });
});
