import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PROVISIONING_STALE_AFTER_MS } from "./provisioning";

const template = readFileSync(
  resolve(import.meta.dirname, "../../../templates/provisioning.yaml"),
  "utf8",
);
const runtimeTemplate = readFileSync(
  resolve(import.meta.dirname, "../../../templates/runtime.yaml"),
  "utf8",
);

function section(source: string, startMarker: string, endMarker: string) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(`Template section markers are missing: ${startMarker}`);
  }
  return source.slice(start, end);
}

function state(name: string): string {
  const marker = `          ${name}:\n`;
  const start = template.indexOf(marker);
  if (start < 0) throw new Error(`State is missing: ${name}`);
  const remaining = template.slice(start + marker.length);
  const next = remaining.search(/^          [A-Za-z][A-Za-z0-9]+:\n/m);
  return next < 0
    ? template.slice(start)
    : template.slice(start, start + marker.length + next);
}

const runtimeCloudFormationRole = section(
  template,
  "  RuntimeCloudFormationRole:",
  "  ProvisioningStateMachineRole:",
);
const stateMachineRole = section(
  template,
  "  ProvisioningStateMachineRole:",
  "  RuntimeProvisioningStateMachine:",
);

describe("runtime provisioning template", () => {
  it("prevents the runtime CloudFormation role from mutating itself", () => {
    const denyControlRoleMutation = section(
      runtimeCloudFormationRole,
      "Sid: NeverMutateOrPassTheControlRole",
      "- PolicyName: ManageRuntimeInstances",
    );
    expect(denyControlRoleMutation).toContain("Effect: Deny");
    expect(denyControlRoleMutation).toContain(
      "NotAction:\n                  - iam:Get*\n                  - iam:List*",
    );
    expect(denyControlRoleMutation).toContain(
      'Resource: !Sub "arn:${AWS::Partition}:iam::${AWS::AccountId}:role/${DeploymentName}-runtime-cfn"',
    );
  });

  it("caps every generated runtime role with the deployment boundary", () => {
    const constrainedRoleCreation = section(
      runtimeCloudFormationRole,
      "Sid: CreateBoundaryConstrainedRuntimeRoles",
      "Sid: ManageNamedRuntimeRoles",
    );
    const namedRoleLifecycle = section(
      runtimeCloudFormationRole,
      "Sid: ManageNamedRuntimeRoles",
      "Sid: AttachOnlySystemsManagerCore",
    );
    const managedPolicyAttachment = section(
      runtimeCloudFormationRole,
      "Sid: AttachOnlySystemsManagerCore",
      "Sid: ManageNamedRuntimeInstanceProfiles",
    );
    expect(template).toContain("RuntimePermissionsBoundaryPolicy:");
    expect(constrainedRoleCreation).toContain("Effect: Allow");
    expect(constrainedRoleCreation).toContain("- iam:CreateRole");
    expect(constrainedRoleCreation).toContain(
      "- iam:PutRolePermissionsBoundary",
    );
    expect(constrainedRoleCreation).toContain("ArnEquals:");
    expect(constrainedRoleCreation).not.toContain("ArnEqualsIfExists");
    expect(constrainedRoleCreation).toContain(
      "iam:PermissionsBoundary: !Ref RuntimePermissionsBoundaryPolicy",
    );
    expect(managedPolicyAttachment).toContain("Effect: Allow");
    expect(managedPolicyAttachment).toContain("ArnEquals:");
    expect(managedPolicyAttachment).not.toContain("ArnEqualsIfExists");
    expect(managedPolicyAttachment).toContain(
      'iam:PolicyARN: !Sub "arn:${AWS::Partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"',
    );
    expect(namedRoleLifecycle).toContain("- iam:DeleteRolePermissionsBoundary");
    expect(namedRoleLifecycle).toContain(
      'Resource: !Sub "arn:${AWS::Partition}:iam::${AWS::AccountId}:role/${DeploymentName}-runtime-*"',
    );
    expect(runtimeCloudFormationRole).not.toContain(
      "Sid: KeepRuntimeBoundaryAttached",
    );
    expect(template).toContain(
      "- ParameterKey: RuntimePermissionsBoundaryArn\n                  ParameterValue: !Ref RuntimePermissionsBoundaryPolicy",
    );
    expect(runtimeTemplate).toContain(
      "PermissionsBoundary: !Ref RuntimePermissionsBoundaryArn",
    );
  });

  it("rejects an instance type that does not match the runtime architecture early", () => {
    expect(template).toContain("MatchArchitectureAndRuntime:");
    expect(template).toContain(
      "AssertDescription: Runtime instance type must match the selected AMI architecture.",
    );
  });

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
    const restrictedStackCreation = section(
      stateMachineRole,
      "PolicyName: CreateRestrictedRuntimeStack",
      "      Tags:",
    );
    expect(restrictedStackCreation).toContain("StringEquals:");
    expect(restrictedStackCreation).not.toContain("IfExists");
    expect(restrictedStackCreation).toContain(
      "cloudformation:RoleArn: !GetAtt RuntimeCloudFormationRole.Arn",
    );
    expect(restrictedStackCreation).toContain(
      'cloudformation:TemplateUrl: !Sub "https://${RuntimeTemplateBucket}.s3.${AWS::Region}.${AWS::URLSuffix}/${RuntimeTemplateKey}"',
    );
    expect(template).not.toContain("RuntimeTemplateUrl:");
    expect(template).toContain(
      'TemplateURL: !Sub "https://${RuntimeTemplateBucket}.s3.${AWS::Region}.${AWS::URLSuffix}/${RuntimeTemplateKey}"',
    );
  });

  it("reconciles failed stacks inside the execution and stale-owner bounds", () => {
    expect(template).toContain("TimeoutSeconds: 5400");
    expect(PROVISIONING_STALE_AFTER_MS - 5_400_000).toBeGreaterThanOrEqual(
      10 * 60 * 1_000,
    );
    expect(state("CanWaitForPriorStackDeletion")).toContain(
      "Variable: $.priorCleanupPollAttempts\n                NumericLessThan: 60",
    );
    expect(state("CanWaitForRuntimeStack")).toContain(
      "Variable: $.stackPollAttempts\n                NumericLessThan: 140",
    );
    expect(state("CanWaitForFailedStackDeletion")).toContain(
      "Variable: $.failedCleanupPollAttempts\n                NumericLessThan: 60",
    );
    const maximumWaitSeconds = 60 * 15 + 140 * 15 + 60 * 15;
    expect(maximumWaitSeconds).toBeLessThan(5_400);
    expect(template).not.toContain("instancePollAttempts");
    expect(template).not.toContain("cleanupPollAttempts");
  });

  it("reserves by idempotent update without replacing unrelated attributes", () => {
    const registration = state("RegisterProvisioning");
    expect(registration).toContain(
      'Resource: !Sub "arn:${AWS::Partition}:states:::aws-sdk:dynamodb:updateItem"',
    );
    expect(registration).toContain(
      "#startedAt = :requestedAt AND #stack = :stackName AND #execution = :execution",
    );
    expect(registration).toContain("#execution = :execution");
    expect(registration).toContain("#startedAt < :staleBefore");
    expect(registration).toContain("REMOVE #instance");
    expect(registration).not.toContain("              Item:");
    expect(template).not.toContain("states:::aws-sdk:dynamodb:putItem");
    expect(
      template.match(/ConditionExpression: .*#execution = :execution/g),
    ).toHaveLength(3);
  });

  it("retries every AWS task with bounded backoff", () => {
    const taskNames = [
      ...template.matchAll(
        /^          ([A-Za-z][A-Za-z0-9]+):\n            Type: Task$/gm,
      ),
    ].map((match) => match[1]);

    expect(taskNames).toHaveLength(13);
    for (const taskName of taskNames) {
      const task = state(taskName);
      expect(task, taskName).toContain("Retry:");
      expect(task, taskName).toContain("MaxAttempts:");
      expect(task, taskName).toContain("BackoffRate: 2");
      expect(task, taskName).toContain("JitterStrategy: FULL");
      const skipRetry = task.indexOf("MaxAttempts: 0");
      if (skipRetry >= 0) {
        expect(skipRetry, taskName).toBeLessThan(
          task.indexOf("- ErrorEquals: [States.TaskFailed]"),
        );
      }
    }
  });

  it("reads the exact stack resource instead of searching reused EC2 tags", () => {
    const lookup = state("FindRuntimeInstance");
    const activation = state("ActivateRuntime");
    expect(lookup).toContain(
      "states:::aws-sdk:cloudformation:describeStackResource",
    );
    expect(lookup).toContain("LogicalResourceId: RuntimeInstance");
    expect(activation).toContain(
      "$.runtime.StackResourceDetail.PhysicalResourceId",
    );
    expect(template).not.toContain("states:::aws-sdk:ec2:describeInstances");
  });

  it("makes runtime stack creation retry-safe and keeps operator inputs fixed", () => {
    const creation = state("CreateRuntimeStack");
    expect(creation).toContain('"ClientRequestToken.$": $$.Execution.Name');
    expect(creation.match(/"ParameterValue\.\$"/g)).toHaveLength(1);
    expect(creation).toContain(
      '- ParameterKey: UserSubject\n                  "ParameterValue.$": $.subject',
    );
  });

  it("preserves the complete ownership payload across counter updates", () => {
    const requiredFields = [
      "subject",
      "email",
      "requestedAt",
      "staleBefore",
      "stackName",
      "stackPollAttempts",
      "priorCleanupPollAttempts",
      "failedCleanupPollAttempts",
    ];
    for (const stateName of [
      "IncrementPriorCleanupPoll",
      "ResetRuntimePolls",
      "IncrementRuntimeStackPoll",
      "IncrementFailedCleanupPoll",
    ]) {
      const counterState = state(stateName);
      for (const field of requiredFields) {
        expect(counterState, `${stateName}.${field}`).toContain(field);
      }
    }
  });

  it("binds launch tags and inference-profile input to the IAM boundaries", () => {
    const runtimeInstance = section(
      runtimeTemplate,
      "  RuntimeInstance:",
      "Outputs:",
    );
    expect(runtimeInstance).toContain(
      "{ Key: AgentFormationDeployment, Value: !Ref DeploymentName }",
    );
    expect(template).toContain(
      "AllowedPattern: '^arn:[A-Za-z0-9-]+:bedrock:[A-Za-z0-9-]+:([0-9]{12})?:",
    );
    expect(runtimeTemplate).toContain(
      "AllowedPattern: '^arn:[A-Za-z0-9-]+:bedrock:[A-Za-z0-9-]+:([0-9]{12})?:",
    );
  });
});
