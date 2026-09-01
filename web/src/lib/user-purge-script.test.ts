import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

type PurgeScenario =
  | "missing-registry"
  | "missing-output"
  | "live-instance"
  | "untagged"
  | "registry-race"
  | "re-enabled";

function runPurge(scenario: PurgeScenario) {
  const fixture = mkdtempSync(join(tmpdir(), "agentformation-purge-guard-"));
  const configFile = join(fixture, "agentformation.json");
  const awsMock = join(fixture, "aws");
  const disableMock = join(fixture, "users-disable.sh");
  const purgeScript = join(fixture, "users-purge.sh");
  const libraryDirectory = join(fixture, "lib");
  const runtimeStack = "example-runtime-123e4567e89b12d3";

  writeFileSync(
    configFile,
    JSON.stringify({ deploymentName: "example", region: "us-west-2" }),
  );
  writeFileSync(
    disableMock,
    "#!/usr/bin/env bash\nset -euo pipefail\nexit 0\n",
  );
  chmodSync(disableMock, 0o755);
  mkdirSync(libraryDirectory);
  for (const library of ["common.sh", "stacks.sh"]) {
    writeFileSync(
      join(libraryDirectory, library),
      readFileSync(
        resolve(import.meta.dirname, `../../../scripts/lib/${library}`),
      ),
    );
  }
  const source = readFileSync(
    resolve(import.meta.dirname, "../../../scripts/users-purge.sh"),
    "utf8",
  ).replace(
    'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    `SCRIPT_DIR=${JSON.stringify(fixture)}`,
  );
  writeFileSync(purgeScript, source);
  chmodSync(purgeScript, 0o755);

  writeFileSync(
    awsMock,
    `#!/usr/bin/env bash
set -euo pipefail
shift 4
service="\${1:-}"
operation="\${2:-}"
shift 2
arguments="$*"
scenario="\${AF_PURGE_SCENARIO:?}"
state="\${AF_PURGE_STATE:?}"
runtime_stack="${runtimeStack}"

not_found() {
  printf 'ValidationError: Stack does not exist\\n' >&2
  exit 255
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
        if [[ "$scenario" == "live-instance" ]]; then
          printf 'i-0123456789abcdef0\\n'
        else
          printf 'None\\n'
        fi
      else
        printf '%s\\n' '{"Stacks":[{"StackName":"example-runtime-123e4567e89b12d3"}]}'
      fi
    elif [[ "$arguments" == "--output json" ]]; then
      if [[ -f "$state/runtime-deleted" ]]; then
        printf '%s\\n' '{"Stacks":[]}'
      elif [[ "$scenario" == "untagged" ]]; then
        printf '%s\\n' '{"Stacks":[{"StackName":"example-runtime-123e4567e89b12d3","Tags":[{"Key":"AgentFormationDeployment","Value":"other"},{"Key":"AgentFormationUserSubject","Value":"123e4567-e89b-12d3-a456-426614174000"}]}]}'
      else
        printf '%s\\n' '{"Stacks":[{"StackName":"example-runtime-123e4567e89b12d3","Tags":[{"Key":"AgentFormationDeployment","Value":"example"},{"Key":"AgentFormationUserSubject","Value":"123e4567-e89b-12d3-a456-426614174000"}]}]}'
      fi
    else
      printf 'Unexpected CloudFormation read: %s\\n' "$arguments" >&2
      exit 64
    fi
    ;;
  "cloudformation delete-stack")
    [[ "$arguments" == *"--stack-name $runtime_stack"* ]] || exit 64
    [[ -f "$state/purge-locked" ]] || exit 65
    if [[ "$scenario" == "live-instance" ]]; then
      [[ -f "$state/instance-stopped" ]] || exit 66
    fi
    : >"$state/runtime-deleted"
    ;;
  "cloudformation wait")
    [[ "$arguments" == *"stack-delete-complete --stack-name $runtime_stack"* ]] || exit 64
    ;;
  "cognito-idp list-users")
    printf '%s\\n' '{"Users":[{"Username":"person","Attributes":[{"Name":"email","Value":"person@example.com"},{"Name":"sub","Value":"123e4567-e89b-12d3-a456-426614174000"}]}]}'
    ;;
  "cognito-idp admin-get-user")
    if [[ "$scenario" == "re-enabled" ]]; then
      printf '%s\\n' '{"Username":"person","Enabled":true,"UserAttributes":[{"Name":"sub","Value":"123e4567-e89b-12d3-a456-426614174000"}]}'
    else
      printf '%s\\n' '{"Username":"person","Enabled":false,"UserAttributes":[{"Name":"sub","Value":"123e4567-e89b-12d3-a456-426614174000"}]}'
    fi
    ;;
  "cognito-idp admin-delete-user")
    [[ -f "$state/purge-locked" ]] || exit 65
    : >"$state/user-deleted"
    ;;
  "dynamodb get-item")
    if [[ "$scenario" == "missing-registry" ]]; then
      printf '%s\\n' '{}'
    elif [[ "$scenario" == "live-instance" ]]; then
      printf '%s\\n' '{"Item":{"userSub":{"S":"123e4567-e89b-12d3-a456-426614174000"},"email":{"S":"person@example.com"},"runtimeStackName":{"S":"example-runtime-123e4567e89b12d3"},"instanceId":{"S":"i-0123456789abcdef0"},"status":{"S":"disabled"},"updatedAt":{"S":"2026-08-28T00:00:00Z"}}}'
    else
      printf '%s\\n' '{"Item":{"userSub":{"S":"123e4567-e89b-12d3-a456-426614174000"},"email":{"S":"person@example.com"},"runtimeStackName":{"S":"example-runtime-123e4567e89b12d3"},"status":{"S":"disabled"},"updatedAt":{"S":"2026-08-28T00:00:00Z"}}}'
    fi
    ;;
  "dynamodb update-item")
    if [[ "$arguments" == *"attribute_not_exists(#purge)"* ]]; then
      [[ "$arguments" == *'"#purge":"purgeLock"'* ]] || exit 64
      [[ "$arguments" == *'"#purgeExpires":"purgeLockExpiresAt"'* ]] || exit 64
      : >"$state/purge-locked"
    elif [[ "$arguments" == *"REMOVE #purge, #purgeExpires"* ]]; then
      [[ -f "$state/purge-locked" ]] || exit 65
      [[ ! -f "$state/runtime-deleted" ]] || exit 66
      : >"$state/purge-lock-released"
    else
      exit 64
    fi
    ;;
  "dynamodb put-item")
    item=""
    previous=""
    for argument in "$@"; do
      if [[ "$previous" == "--item" ]]; then
        item="$argument"
      fi
      previous="$argument"
    done
    if [[ "$item" == *'"status":{"S":"disabled"}'* ]]; then
      [[ "$scenario" == "missing-registry" ]] || exit 64
      [[ "$arguments" == *"attribute_not_exists(userSub)"* ]] || exit 64
      : >"$state/purge-locked"
    elif [[ "$item" == *'"status":{"S":"purged"}'* ]]; then
      [[ -f "$state/user-deleted" ]] || exit 65
      [[ "$item" == *'"expiresAt":{"N":"'* ]] || exit 64
      [[ "$item" != *'"email"'* ]] || exit 64
      [[ "$item" != *'"runtimeStackName"'* ]] || exit 64
      [[ "$arguments" == *"#purge = :purge"* ]] || exit 64
      if [[ "$scenario" == "registry-race" ]]; then
        printf 'ConditionalCheckFailedException\\n' >&2
        exit 255
      fi
      : >"$state/registry-tombstoned"
    else
      exit 64
    fi
    ;;
  "ec2 describe-instances")
    [[ "$scenario" == "live-instance" ]] || exit 64
    printf 'running\\n'
    ;;
  "ssm describe-sessions")
    [[ "$scenario" == "live-instance" ]] || exit 64
    printf '%s\\n' '[]'
    ;;
  "ec2 stop-instances")
    [[ "$scenario" == "live-instance" ]] || exit 64
    : >"$state/instance-stopped"
    printf '%s\\n' '{}'
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
    [purgeScript, "--email", "person@example.com", "--confirm", "DELETE"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        AF_PURGE_SCENARIO: scenario,
        AF_PURGE_STATE: fixture,
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

describe("permanent user purge", () => {
  it("deletes a subject-bound failed stack even without an InstanceId output", () => {
    const run = runPurge("missing-output");
    try {
      expect(run.result.stderr).toBe("");
      expect(run.result.status).toBe(0);
      expect(run.wasCreated("purge-locked")).toBe(true);
      expect(run.wasCreated("runtime-deleted")).toBe(true);
      expect(run.wasCreated("registry-tombstoned")).toBe(true);
      expect(run.wasCreated("user-deleted")).toBe(true);
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  });

  it("creates a lock and final tombstone when the registry row was missing", () => {
    const run = runPurge("missing-registry");
    try {
      expect(run.result.stderr).toBe("");
      expect(run.result.status).toBe(0);
      expect(run.wasCreated("purge-locked")).toBe(true);
      expect(run.wasCreated("registry-tombstoned")).toBe(true);
      expect(run.wasCreated("user-deleted")).toBe(true);
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  });

  it("stops a subject-bound live instance before deleting its stack", () => {
    const run = runPurge("live-instance");
    try {
      expect(run.result.stderr).toBe("");
      expect(run.result.status).toBe(0);
      expect(run.wasCreated("purge-locked")).toBe(true);
      expect(run.wasCreated("instance-stopped")).toBe(true);
      expect(run.wasCreated("runtime-deleted")).toBe(true);
      expect(run.wasCreated("user-deleted")).toBe(true);
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  });

  it("refuses an expected stack that is not tagged to the subject and deployment", () => {
    const run = runPurge("untagged");
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain(
        "expected runtime stack is not tagged for this user",
      );
      expect(run.wasCreated("runtime-deleted")).toBe(false);
      expect(run.wasCreated("user-deleted")).toBe(false);
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  });

  it("keeps a fail-closed lock when the final tombstone write races", () => {
    const run = runPurge("registry-race");
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain(
        "locked registry record changed before its privacy tombstone",
      );
      expect(run.wasCreated("runtime-deleted")).toBe(true);
      expect(run.wasCreated("registry-tombstoned")).toBe(false);
      expect(run.wasCreated("user-deleted")).toBe(true);
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  });

  it("does not delete a stack when company sign-in was re-enabled", () => {
    const run = runPurge("re-enabled");
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain(
        "Company sign-in was re-enabled before purge",
      );
      expect(run.wasCreated("runtime-deleted")).toBe(false);
      expect(run.wasCreated("user-deleted")).toBe(false);
      expect(run.wasCreated("purge-lock-released")).toBe(true);
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  });
});
