import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const subject = "123e4567-e89b-12d3-a456-426614174000";
const instanceId = "i-0123456789abcdef0";

interface EnableScenario {
  runtime: string;
  lockAfter?: 1;
  redisableAfter?: 1;
  statusChangeAfter?: 1;
  enableFailure?: boolean;
  disableFailure?: boolean;
  stopFailure?: boolean;
  putFailure?: boolean;
}

function registryItem(
  status: "active" | "disabled" | "failed",
  options: {
    enableLease?: "expired" | "live" | "partial";
    instanceId?: string;
    purgeLocked?: boolean;
  } = {},
): string {
  const item: Record<string, { S: string } | { N: string }> = {
    userSub: { S: subject },
    email: { S: "person@example.com" },
    runtimeStackName: { S: "example-runtime-123e4567e89b12d3" },
    status: { S: status },
    updatedAt: { S: "2026-08-28T00:00:00Z" },
  };
  if (options.instanceId) item.instanceId = { S: options.instanceId };
  if (options.enableLease) {
    item.enableToken = { S: "live-enable" };
    if (options.enableLease !== "partial") {
      item.enableTokenExpiresAt = {
        N: options.enableLease === "live" ? "4102444800" : "1",
      };
    }
  }
  if (options.purgeLocked) {
    item.purgeLock = { S: "lock-id" };
    item.purgeLockExpiresAt = { N: "1777000000" };
  }
  return JSON.stringify({ Item: item });
}

function runEnableScenario(scenario: EnableScenario) {
  const fixture = mkdtempSync(join(tmpdir(), "agentformation-enable-guard-"));
  const awsMock = join(fixture, "aws");
  const callLog = join(fixture, "calls.log");
  const updateCount = join(fixture, "update-count");
  const configFile = join(fixture, "agentformation.json");
  writeFileSync(
    configFile,
    JSON.stringify({ deploymentName: "example", region: "us-west-2" }),
  );
  writeFileSync(
    awsMock,
    `#!/usr/bin/env bash
set -euo pipefail
shift 4
command="$*"
printf '%s\n' "$command" >>"$AF_CALL_LOG"
case "$command" in
  *"cloudformation describe-stacks --stack-name example-foundation"*"UserPoolId"*) printf 'pool-id\n' ;;
  *"cloudformation describe-stacks --stack-name example-foundation"*"UserRegistryTableName"*) printf 'registry-table\n' ;;
  "cognito-idp list-users"*) printf '%s\n' '{"Users":[{"Username":"person","Attributes":[{"Name":"email","Value":"person@example.com"},{"Name":"sub","Value":"${subject}"}]}]}' ;;
  "dynamodb get-item"*) printf '%s\n' "$AF_RUNTIME_JSON" ;;
  "dynamodb put-item"*)
    if [[ "$AF_PUT_FAILURE" == "true" ]]; then
      printf 'ConditionalCheckFailedException\n' >&2
      exit 255
    fi
    printf '%s\n' '{}'
    ;;
  "dynamodb update-item"*)
    condition_expression=""
    update_expression=""
    previous=""
    for argument in "$@"; do
      if [[ "$previous" == "--condition-expression" ]]; then
        condition_expression="$argument"
      elif [[ "$previous" == "--update-expression" ]]; then
        update_expression="$argument"
      fi
      previous="$argument"
    done
    if [[ "$AF_RUNTIME_JSON" == *'"purgeLock"'* && "$condition_expression" == *"attribute_not_exists(#purge)"* ]]; then
      printf 'ConditionalCheckFailedException\n' >&2
      exit 255
    fi
    if [[ "$AF_RUNTIME_JSON" == *'"enableToken"'* && "$AF_RUNTIME_JSON" != *'"enableTokenExpiresAt":{"N":"1"}'* && "$condition_expression" == *"attribute_not_exists(#enable)"* ]]; then
      printf 'ConditionalCheckFailedException\n' >&2
      exit 255
    fi
    count=0
    [[ ! -f "$AF_UPDATE_COUNT" ]] || count="$(<"$AF_UPDATE_COUNT")"
    count=$((count + 1))
    printf '%s\n' "$count" >"$AF_UPDATE_COUNT"
    if [[ "$AF_LOCK_AFTER" -gt 0 && "$count" -gt "$AF_LOCK_AFTER" && ( "$condition_expression" == *"attribute_not_exists(#purge)"* || "$condition_expression" == *"attribute_not_exists(#purgeExpires)"* ) ]]; then
      printf 'ConditionalCheckFailedException\n' >&2
      exit 255
    fi
    if [[ "$AF_STATUS_CHANGE_AFTER" -gt 0 && "$count" -gt "$AF_STATUS_CHANGE_AFTER" && "$condition_expression" == *"#status ="* ]]; then
      printf 'ConditionalCheckFailedException\n' >&2
      exit 255
    fi
    if [[ "$AF_REDISABLE_AFTER" -gt 0 && "$count" -gt "$AF_REDISABLE_AFTER" && "$condition_expression" == *"#enable = :enable"* ]]; then
      printf 'ConditionalCheckFailedException\n' >&2
      exit 255
    fi
    printf '%s\n' '{}'
    ;;
  "cognito-idp admin-enable-user"*)
    if [[ "$AF_ENABLE_FAILURE" == "true" ]]; then
      printf 'Cognito enable result was not confirmed\n' >&2
      exit 255
    fi
    printf '%s\n' '{}'
    ;;
  "cognito-idp admin-disable-user"*)
    if [[ "$AF_DISABLE_FAILURE" == "true" ]]; then
      printf 'Cognito rollback failed\n' >&2
      exit 255
    fi
    printf '%s\n' '{}'
    ;;
  "ec2 start-instances"*) printf '%s\n' '{}' ;;
  "ec2 stop-instances"*)
    if [[ "$AF_STOP_FAILURE" == "true" ]]; then
      printf 'EC2 stop result was not confirmed\n' >&2
      exit 255
    fi
    printf '%s\n' '{}'
    ;;
  "ec2 describe-instances"*) printf 'running\n' ;;
  "ssm describe-sessions"*) printf '%s\n' '[]' ;;
  *) printf 'Unexpected mock AWS call: %s\n' "$command" >&2; exit 64 ;;
esac
`,
  );
  chmodSync(awsMock, 0o755);

  try {
    const result = spawnSync(
      "bash",
      [
        resolve(import.meta.dirname, "../../../scripts/users-enable.sh"),
        "--email",
        "person@example.com",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          AF_CALL_LOG: callLog,
          AF_DISABLE_FAILURE: scenario.disableFailure ? "true" : "false",
          AF_ENABLE_FAILURE: scenario.enableFailure ? "true" : "false",
          AF_LOCK_AFTER: scenario.lockAfter ? String(scenario.lockAfter) : "0",
          AF_PUT_FAILURE: scenario.putFailure ? "true" : "false",
          AF_REDISABLE_AFTER: scenario.redisableAfter
            ? String(scenario.redisableAfter)
            : "0",
          AF_RUNTIME_JSON: scenario.runtime,
          AF_STATUS_CHANGE_AFTER: scenario.statusChangeAfter
            ? String(scenario.statusChangeAfter)
            : "0",
          AF_STOP_FAILURE: scenario.stopFailure ? "true" : "false",
          AF_UPDATE_COUNT: updateCount,
          AGENTFORMATION_CONFIG: configFile,
          LANG: "C",
          LC_ALL: "C",
          PATH: `${fixture}:${process.env.PATH ?? ""}`,
        },
      },
    );
    const calls = existsSync(callLog)
      ? readFileSync(callLog, "utf8").trim().split("\n")
      : [];
    return { calls, result };
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

function sideEffectCalls(calls: string[]) {
  return calls.filter(
    (call) =>
      call.startsWith("cognito-idp admin-enable-user") ||
      call.startsWith("cognito-idp admin-disable-user") ||
      call.startsWith("ec2 start-instances") ||
      call.startsWith("ec2 stop-instances"),
  );
}

describe("users enable purge guards", () => {
  it.each([
    ["active", registryItem("active", { purgeLocked: true })],
    ["failed", registryItem("failed", { purgeLocked: true })],
    [
      "disabled without an instance",
      registryItem("disabled", { purgeLocked: true }),
    ],
    [
      "disabled with a preserved instance",
      registryItem("disabled", { instanceId, purgeLocked: true }),
    ],
  ])("starts no side effect for a locked %s row", (_description, runtime) => {
    const { calls, result } = runEnableScenario({
      runtime,
    });

    expect(result.status).not.toBe(0);
    expect(sideEffectCalls(calls)).toEqual([]);
  });

  it("starts no side effect while another enable lease is live", () => {
    const { calls, result } = runEnableScenario({
      runtime: registryItem("disabled", { enableLease: "live", instanceId }),
    });

    expect(result.status).not.toBe(0);
    expect(sideEffectCalls(calls)).toEqual([]);
  });

  it("starts no side effect for a half-written enable lease", () => {
    const { calls, result } = runEnableScenario({
      runtime: registryItem("disabled", {
        enableLease: "partial",
        instanceId,
      }),
    });

    expect(result.status).not.toBe(0);
    expect(sideEffectCalls(calls)).toEqual([]);
  });

  it("reclaims an expired enable lease before starting side effects", () => {
    const { calls, result } = runEnableScenario({
      runtime: registryItem("disabled", { enableLease: "expired" }),
    });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(sideEffectCalls(calls)).toEqual([
      expect.stringContaining("admin-enable-user"),
    ]);
  });

  it("enables a disabled user without an instance after two conditional guards", () => {
    const { calls, result } = runEnableScenario({
      runtime: registryItem("disabled"),
    });
    const relevantCalls = calls.filter(
      (call) =>
        call.startsWith("dynamodb update-item") ||
        call.startsWith("cognito-idp admin-enable-user"),
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(relevantCalls).toHaveLength(3);
    expect(relevantCalls[0]).toContain("#enable = :enable");
    expect(relevantCalls[0]).toContain("#status = :disabled");
    expect(relevantCalls[0]).toContain("attribute_not_exists(instanceId)");
    expect(relevantCalls[1]).toContain("admin-enable-user");
    expect(relevantCalls[2]).toContain("#status = :disabled");
    expect(relevantCalls[2]).toContain("#enable = :enable");
    expect(relevantCalls[2]).toContain("REMOVE #enable, #enableExpires");
    expect(relevantCalls[2]).toContain("attribute_not_exists(instanceId)");
    expect(relevantCalls[2]).toContain("attribute_not_exists(#purge)");
    expect(relevantCalls[2]).toContain("attribute_not_exists(#purgeExpires)");
  });

  it("starts a preserved instance only after pinning it with a conditional guard", () => {
    const { calls, result } = runEnableScenario({
      runtime: registryItem("disabled", { instanceId }),
    });
    const relevantCalls = calls.filter(
      (call) =>
        call.startsWith("dynamodb update-item") ||
        call.startsWith("ec2 start-instances") ||
        call.startsWith("cognito-idp admin-enable-user"),
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(relevantCalls).toHaveLength(4);
    expect(relevantCalls[0]).toContain("#enable = :enable");
    expect(relevantCalls[0]).toContain("#status = :disabled");
    expect(relevantCalls[0]).toContain("#instance = :observedInstance");
    expect(relevantCalls[1]).toContain("ec2 start-instances");
    expect(relevantCalls[2]).toContain("admin-enable-user");
    expect(relevantCalls[3]).toContain("#status = :disabled");
    expect(relevantCalls[3]).toContain("#enable = :enable");
    expect(relevantCalls[3]).toContain("REMOVE #enable, #enableExpires");
    expect(relevantCalls[3]).toContain("#instance = :observedInstance");
    expect(relevantCalls[3]).toContain("attribute_not_exists(#purge)");
    expect(relevantCalls[3]).toContain("attribute_not_exists(#purgeExpires)");
  });

  it("disables Cognito again when a purge lock appears after the no-instance preflight", () => {
    const { calls, result } = runEnableScenario({
      runtime: registryItem("disabled"),
      lockAfter: 1,
    });

    expect(result.status).not.toBe(0);
    expect(sideEffectCalls(calls)).toEqual([
      expect.stringContaining("admin-enable-user"),
      expect.stringContaining("admin-disable-user"),
    ]);
  });

  it("disables Cognito and stops the instance when a purge lock appears after preflight", () => {
    const { calls, result } = runEnableScenario({
      runtime: registryItem("disabled", { instanceId }),
      lockAfter: 1,
    });

    expect(result.status).not.toBe(0);
    expect(sideEffectCalls(calls)).toEqual([
      expect.stringContaining("ec2 start-instances"),
      expect.stringContaining("admin-enable-user"),
      expect.stringContaining("admin-disable-user"),
      expect.stringContaining("ec2 stop-instances"),
    ]);
  });

  it("warns instead of claiming sign-in is disabled when the Cognito rollback fails", () => {
    const { result } = runEnableScenario({
      runtime: registryItem("disabled"),
      lockAfter: 1,
      disableFailure: true,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "WARNING: Cognito sign-in could not be disabled again; check the user before retrying.",
    );
    expect(result.stderr).not.toContain("sign-in remains disabled");
  });

  it("rolls Cognito back when disable changes the status after preflight", () => {
    const { calls, result } = runEnableScenario({
      runtime: registryItem("failed"),
      statusChangeAfter: 1,
    });

    expect(result.status).not.toBe(0);
    expect(sideEffectCalls(calls)).toEqual([
      expect.stringContaining("admin-enable-user"),
      expect.stringContaining("admin-disable-user"),
    ]);
  });

  it("rolls Cognito and EC2 back when disable invalidates the enable lease", () => {
    const { calls, result } = runEnableScenario({
      runtime: registryItem("disabled", { instanceId }),
      redisableAfter: 1,
    });

    expect(result.status).not.toBe(0);
    expect(sideEffectCalls(calls)).toEqual([
      expect.stringContaining("ec2 start-instances"),
      expect.stringContaining("admin-enable-user"),
      expect.stringContaining("admin-disable-user"),
      expect.stringContaining("ec2 stop-instances"),
    ]);
  });

  it("does not claim a Cognito result when both late rollbacks are unconfirmed", () => {
    const { result } = runEnableScenario({
      runtime: registryItem("disabled", { instanceId }),
      lockAfter: 1,
      disableFailure: true,
      stopFailure: true,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "WARNING: Cognito sign-in could not be disabled again; check the user before retrying.",
    );
    expect(result.stderr).toContain(
      "WARNING: The preserved runtime could not be stopped after the enable attempt failed.",
    );
    expect(result.stderr).not.toContain("Sign-in was disabled again");
  });

  it("does not claim sign-in stayed disabled when enabling and runtime cutoff are unconfirmed", () => {
    const { result } = runEnableScenario({
      runtime: registryItem("disabled", { instanceId }),
      enableFailure: true,
      stopFailure: true,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "WARNING: The preserved runtime could not be stopped after the enable attempt failed.",
    );
    expect(result.stderr).not.toContain("Sign-in remained disabled");
  });

  it("creates and conditionally guards a missing registry row before enabling sign-in", () => {
    const { calls, result } = runEnableScenario({ runtime: "{}" });
    const writes = calls.filter(
      (call) =>
        call.startsWith("dynamodb put-item") ||
        call.startsWith("dynamodb update-item"),
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(writes).toHaveLength(3);
    expect(writes[0]).toContain("attribute_not_exists(userSub)");
    expect(writes[1]).toContain("#status = :expected");
    expect(writes[1]).toContain("#enable = :enable");
    expect(writes[1]).toContain("attribute_not_exists(#purge)");
    expect(writes[2]).toContain("#status = :expected");
    expect(writes[2]).toContain("#enable = :enable");
    expect(writes[2]).toContain("REMOVE #enable, #enableExpires");
    expect(writes[2]).toContain("attribute_not_exists(#purge)");
    expect(sideEffectCalls(calls)).toEqual([
      expect.stringContaining("admin-enable-user"),
    ]);
  });

  it("cannot create a missing row over a purge tombstone", () => {
    const { calls, result } = runEnableScenario({
      runtime: "{}",
      putFailure: true,
    });

    expect(result.status).not.toBe(0);
    expect(
      calls.some((call) => call.includes("attribute_not_exists(userSub)")),
    ).toBe(true);
    expect(sideEffectCalls(calls)).toEqual([]);
  });

  it("cannot enable a short-lived purged tombstone", () => {
    const { calls, result } = runEnableScenario({
      runtime: JSON.stringify({
        Item: {
          userSub: { S: subject },
          status: { S: "purged" },
          updatedAt: { S: "2026-08-28T00:00:00Z" },
          expiresAt: { N: "1777000000" },
        },
      }),
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("That runtime is not ready to be enabled");
    expect(sideEffectCalls(calls)).toEqual([]);
    expect(calls.some((call) => call.startsWith("dynamodb update-item"))).toBe(
      false,
    );
  });
});
