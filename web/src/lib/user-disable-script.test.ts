import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

type DisableScenario =
  | "active-runtime"
  | "failed-without-output"
  | "failed-with-expired-purge-lock"
  | "ambiguous-purge-lock-expiry"
  | "disabled-enable-lease"
  | "live-purge-lock"
  | "expired-purge-lock";

function runDisable(scenario: DisableScenario) {
  const fixture = mkdtempSync(join(tmpdir(), "agentformation-disable-guard-"));
  const configFile = join(fixture, "agentformation.json");
  const awsMock = join(fixture, "aws");
  const runtimeStack = "example-runtime-123e4567e89b12d3";

  writeFileSync(
    configFile,
    JSON.stringify({ deploymentName: "example", region: "us-west-2" }),
  );
  writeFileSync(
    awsMock,
    `#!/usr/bin/env bash
set -euo pipefail
shift 4
service="\${1:-}"
operation="\${2:-}"
shift 2
arguments="$*"
scenario="\${AF_DISABLE_SCENARIO:?}"
state="\${AF_DISABLE_STATE:?}"
runtime_stack="${runtimeStack}"

not_found() {
  printf 'ValidationError: Stack does not exist\\n' >&2
  exit 255
}

registry_item() {
  if [[ "$scenario" == "active-runtime" ]]; then
    printf '%s\\n' '{"Item":{"userSub":{"S":"123e4567-e89b-12d3-a456-426614174000"},"email":{"S":"person@example.com"},"runtimeStackName":{"S":"example-runtime-123e4567e89b12d3"},"instanceId":{"S":"i-0123456789abcdef0"},"status":{"S":"active"},"updatedAt":{"S":"2026-08-28T00:00:00Z"}}}'
  elif [[ "$scenario" == "live-purge-lock" ]]; then
    printf '%s\\n' '{"Item":{"userSub":{"S":"123e4567-e89b-12d3-a456-426614174000"},"email":{"S":"person@example.com"},"runtimeStackName":{"S":"example-runtime-123e4567e89b12d3"},"status":{"S":"disabled"},"updatedAt":{"S":"2026-08-28T00:00:00Z"},"purgeLock":{"S":"live-lock"},"purgeLockExpiresAt":{"N":"4102444800"}}}'
  elif [[ "$scenario" == "expired-purge-lock" ]]; then
    printf '%s\\n' '{"Item":{"userSub":{"S":"123e4567-e89b-12d3-a456-426614174000"},"email":{"S":"person@example.com"},"runtimeStackName":{"S":"example-runtime-123e4567e89b12d3"},"status":{"S":"disabled"},"updatedAt":{"S":"2026-08-28T00:00:00Z"},"purgeLock":{"S":"expired-lock"},"purgeLockExpiresAt":{"N":"1"}}}'
  elif [[ "$scenario" == "failed-with-expired-purge-lock" ]]; then
    printf '%s\\n' '{"Item":{"userSub":{"S":"123e4567-e89b-12d3-a456-426614174000"},"email":{"S":"person@example.com"},"runtimeStackName":{"S":"example-runtime-123e4567e89b12d3"},"status":{"S":"failed"},"updatedAt":{"S":"2026-08-28T00:00:00Z"},"purgeLock":{"S":"expired-lock"},"purgeLockExpiresAt":{"N":"1"}}}'
  elif [[ "$scenario" == "ambiguous-purge-lock-expiry" ]]; then
    printf '%s\\n' '{"Item":{"userSub":{"S":"123e4567-e89b-12d3-a456-426614174000"},"email":{"S":"person@example.com"},"runtimeStackName":{"S":"example-runtime-123e4567e89b12d3"},"status":{"S":"disabled"},"updatedAt":{"S":"2026-08-28T00:00:00Z"},"purgeLock":{"S":"ambiguous-lock"},"purgeLockExpiresAt":{"N":"08"}}}'
  elif [[ "$scenario" == "disabled-enable-lease" ]]; then
    printf '%s\\n' '{"Item":{"userSub":{"S":"123e4567-e89b-12d3-a456-426614174000"},"email":{"S":"person@example.com"},"runtimeStackName":{"S":"example-runtime-123e4567e89b12d3"},"instanceId":{"S":"i-0123456789abcdef0"},"status":{"S":"disabled"},"updatedAt":{"S":"2026-08-28T00:00:00Z"},"enableToken":{"S":"live-enable"},"enableTokenExpiresAt":{"N":"4102444800"}}}'
  else
    printf '%s\\n' '{"Item":{"userSub":{"S":"123e4567-e89b-12d3-a456-426614174000"},"email":{"S":"person@example.com"},"runtimeStackName":{"S":"example-runtime-123e4567e89b12d3"},"status":{"S":"failed"},"updatedAt":{"S":"2026-08-28T00:00:00Z"}}}'
  fi
}

case "$service $operation" in
  "cloudformation describe-stacks")
    if [[ "$arguments" == *"--stack-name example-foundation"*"UserPoolId"* ]]; then
      printf 'pool-id\\n'
    elif [[ "$arguments" == *"--stack-name example-foundation"*"UserRegistryTableName"* ]]; then
      printf 'registry-table\\n'
    elif [[ "$arguments" == *"--stack-name example-provisioning"* ]]; then
      not_found
    elif [[ "$arguments" == *"--stack-name $runtime_stack"* ]]; then
      [[ ! -f "$state/runtime-deleted" ]] || not_found
      if [[ "$arguments" == *"OutputKey=='InstanceId'"* ]]; then
        if [[ "$scenario" == "active-runtime" || "$scenario" == "disabled-enable-lease" ]]; then
          printf 'i-0123456789abcdef0\\n'
        else
          printf 'None\\n'
        fi
      else
        printf '%s\\n' '{"Stacks":[{"StackName":"example-runtime-123e4567e89b12d3"}]}'
      fi
    else
      printf 'Unexpected CloudFormation read: %s\\n' "$arguments" >&2
      exit 64
    fi
    ;;
  "cloudformation delete-stack")
    [[ "$scenario" == "failed-without-output" || "$scenario" == "failed-with-expired-purge-lock" ]] || exit 64
    [[ -f "$state/registry-updated" ]] || exit 65
    : >"$state/runtime-deleted"
    ;;
  "cloudformation wait")
    [[ "$scenario" == "failed-without-output" || "$scenario" == "failed-with-expired-purge-lock" ]] || exit 64
    [[ "$arguments" == *"stack-delete-complete --stack-name $runtime_stack"* ]] || exit 64
    ;;
  "cognito-idp list-users")
    printf '%s\\n' '{"Users":[{"Username":"person","Attributes":[{"Name":"email","Value":"person@example.com"},{"Name":"sub","Value":"123e4567-e89b-12d3-a456-426614174000"}]}]}'
    ;;
  "cognito-idp admin-disable-user"|"cognito-idp admin-user-global-sign-out")
    printf '%s\\n' '{}'
    ;;
  "dynamodb get-item")
    registry_item
    ;;
  "dynamodb update-item")
    update_expression=""
    previous=""
    for argument in "$@"; do
      if [[ "$previous" == "--update-expression" ]]; then
        update_expression="$argument"
      fi
      previous="$argument"
    done
    if [[ "$scenario" != "expired-purge-lock" && "$scenario" != "failed-with-expired-purge-lock" ]]; then
      [[ "$arguments" == *"attribute_not_exists(#purge)"* ]] || exit 64
      [[ "$arguments" == *"attribute_not_exists(#purgeExpires)"* ]] || exit 64
    fi
    if [[ "$scenario" == "active-runtime" || "$scenario" == "disabled-enable-lease" ]]; then
      [[ "$update_expression" == 'SET #status = :disabled, updatedAt = :updatedAt, #instance = :securedInstance REMOVE #enable, #enableExpires' ]] || exit 66
      if [[ "$scenario" == "disabled-enable-lease" ]]; then
        : >"$state/enable-lease-cleared"
      fi
    elif [[ "$scenario" == "expired-purge-lock" ]]; then
      [[ "$update_expression" == 'SET #status = :disabled, updatedAt = :updatedAt REMOVE #enable, #enableExpires, #purge, #purgeExpires' ]] || exit 68
      [[ "$arguments" == *"#purge = :observedPurge"* ]] || exit 69
      : >"$state/purge-lock-cleared"
    elif [[ "$scenario" == "failed-with-expired-purge-lock" ]]; then
      [[ "$update_expression" == 'SET #status = :disabled, updatedAt = :updatedAt REMOVE #enable, #enableExpires, #purge, #purgeExpires, #instance' ]] || exit 70
      [[ "$arguments" == *"#purge = :observedPurge"* ]] || exit 71
      : >"$state/purge-lock-cleared"
    else
      [[ "$update_expression" == 'SET #status = :disabled, updatedAt = :updatedAt REMOVE #enable, #enableExpires, #instance' ]] || exit 67
    fi
    : >"$state/registry-updated"
    ;;
  "ec2 describe-instances")
    [[ "$scenario" == "active-runtime" || "$scenario" == "disabled-enable-lease" ]] || exit 64
    printf 'stopped\\n'
    ;;
  *)
    printf 'Unexpected mock AWS call: %s %s %s\\n' "$service" "$operation" "$arguments" >&2
    exit 64
    ;;
esac
`,
  );
  chmodSync(awsMock, 0o755);

  const result = spawnSync(
    "bash",
    [
      resolve(import.meta.dirname, "../../../scripts/users-disable.sh"),
      "--email",
      "person@example.com",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        AF_DISABLE_SCENARIO: scenario,
        AF_DISABLE_STATE: fixture,
        AGENTFORMATION_CONFIG: configFile,
        LANG: "C",
        LC_ALL: "C",
        PATH: `${fixture}:${process.env.PATH ?? ""}`,
      },
    },
  );

  return {
    fixture,
    result,
    wasCreated(name: string) {
      return existsSync(join(fixture, name));
    },
  };
}

describe("user disable convergence", () => {
  it("writes a valid update expression for an active runtime", () => {
    const run = runDisable("active-runtime");
    try {
      expect(run.result.stderr).toBe("");
      expect(run.result.status).toBe(0);
      expect(run.wasCreated("registry-updated")).toBe(true);
      expect(run.wasCreated("runtime-deleted")).toBe(false);
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  });

  it("deletes a failed stack that has no InstanceId output", () => {
    const run = runDisable("failed-without-output");
    try {
      expect(run.result.stderr).toBe("");
      expect(run.result.status).toBe(0);
      expect(run.wasCreated("registry-updated")).toBe(true);
      expect(run.wasCreated("runtime-deleted")).toBe(true);
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  });

  it("fails closed without rewriting a live purge lock", () => {
    const run = runDisable("live-purge-lock");
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain(
        "A permanent purge is already in progress for this user",
      );
      expect(run.wasCreated("registry-updated")).toBe(false);
      expect(run.wasCreated("runtime-deleted")).toBe(false);
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  });

  it("clears an expired purge lock while keeping the user disabled", () => {
    const run = runDisable("expired-purge-lock");
    try {
      expect(run.result.stderr).toBe("");
      expect(run.result.status).toBe(0);
      expect(run.wasCreated("registry-updated")).toBe(true);
      expect(run.wasCreated("purge-lock-cleared")).toBe(true);
      expect(run.wasCreated("runtime-deleted")).toBe(false);
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  });

  it("clears an expired purge lock and a missing failed-runtime pointer in one valid update", () => {
    const run = runDisable("failed-with-expired-purge-lock");
    try {
      expect(run.result.stderr).toBe("");
      expect(run.result.status).toBe(0);
      expect(run.wasCreated("registry-updated")).toBe(true);
      expect(run.wasCreated("purge-lock-cleared")).toBe(true);
      expect(run.wasCreated("runtime-deleted")).toBe(true);
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  });

  it("fails closed on a non-canonical purge-lock expiry", () => {
    const run = runDisable("ambiguous-purge-lock-expiry");
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain("invalid purgeLockExpiresAt");
      expect(run.wasCreated("registry-updated")).toBe(false);
      expect(run.wasCreated("purge-lock-cleared")).toBe(false);
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  });

  it("invalidates an in-flight enable lease while keeping the user disabled", () => {
    const run = runDisable("disabled-enable-lease");
    try {
      expect(run.result.stderr).toBe("");
      expect(run.result.status).toBe(0);
      expect(run.wasCreated("registry-updated")).toBe(true);
      expect(run.wasCreated("enable-lease-cleared")).toBe(true);
      expect(run.wasCreated("runtime-deleted")).toBe(false);
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  });
});
