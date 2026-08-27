import {
  chmodSync,
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

function readScript(name: string) {
  return readFileSync(
    resolve(import.meta.dirname, `../../../scripts/${name}`),
    "utf8",
  );
}

describe("operator script safety contracts", () => {
  it("never expires the live provisioning template", () => {
    const deploy = readScript("deploy.sh");
    expect(deploy).toContain("agentformation-lifecycle=current");
    expect(deploy).toContain("agentformation-lifecycle=superseded");
    expect(deploy).toContain(
      '[[ "$template_key" == "$RUNTIME_TEMPLATE_KEY" ]] && continue',
    );
    expect(deploy).toContain("--metadata-directive REPLACE");
    expect(deploy).toContain("Skipping an unexpected object");
    expect(
      deploy.lastIndexOf("retire_superseded_runtime_templates"),
    ).toBeGreaterThan(deploy.lastIndexOf("deploy_foundation_stack true"));
  });

  it("keeps upload CORS on POST and rejects malformed public addresses", () => {
    const deploy = readScript("deploy.sh");
    const common = resolve(
      import.meta.dirname,
      "../../../scripts/lib/common.sh",
    );
    expect(deploy).not.toContain("AllowLegacyUploadPut");
    expect(deploy).toContain("require_https_origin");
    for (const value of [
      "https://agentformation.example",
      "https://localhost",
      "https://agentformation.example:8443",
    ]) {
      expect(
        spawnSync(
          "bash",
          [
            "-c",
            'source "$1"; require_https_origin publicUrl "$2"',
            "origin-test",
            common,
            value,
          ],
          { encoding: "utf8" },
        ).status,
      ).toBe(0);
    }
    for (const value of [
      "http://agentformation.example",
      "https://agentformation.example/",
      "https://agentformation.example/path",
      "https://user@agentformation.example",
      "https://agentformation.example#fragment",
      "https://.agentformation.example",
      "https://agentformation..example",
      "https://agentformation.example:0",
      "https://agentformation.example:65536",
    ]) {
      const result = spawnSync(
        "bash",
        [
          "-c",
          'source "$1"; require_https_origin publicUrl "$2"',
          "origin-test",
          common,
          value,
        ],
        { encoding: "utf8" },
      );
      expect(result.status, value).not.toBe(0);
      expect(result.stderr, value).toContain("publicUrl must");
    }
  });

  it("deploys the web image by the digest ECR returned after push", () => {
    const deploy = readScript("deploy.sh");
    expect(deploy).toContain("ecr describe-images");
    expect(deploy).toContain(
      '[[ "$WEB_IMAGE_DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]]',
    );
    expect(deploy).toContain(
      'WEB_IMAGE_IDENTIFIER="$REPOSITORY_URI@$WEB_IMAGE_DIGEST"',
    );
    expect(deploy).toContain('ImageIdentifier="$WEB_IMAGE_IDENTIFIER"');
    expect(deploy.indexOf("create-identity-provider")).toBeLessThan(
      deploy.indexOf('deploy_foundation_stack true "$INITIAL_PUBLIC_URL"'),
    );
  });

  it("restores the bucket policy when teardown does not finish", () => {
    const destroy = readScript("destroy.sh");
    expect(destroy).toContain("ORIGINAL_BUCKET_POLICY=");
    expect(destroy).toContain(
      'map(select(.Sid != "DenyNewUploadsDuringTeardown"))',
    );
    expect(destroy).toContain("restore_bucket_policy()");
    expect(destroy).toContain('--expected-bucket-owner "$ACCOUNT_ID"');
    expect(destroy).toContain("trap 'exit 129' HUP");
    expect(destroy).toContain("trap 'exit 131' QUIT");
    expect(destroy).toContain("list-object-versions");
    expect(destroy).toContain("--no-paginate");
    expect(destroy).not.toContain("batch-delete-image");
    expect(destroy).toContain("assert_no_runtime_stacks");
    expect(destroy).toContain("quiesce_image_builder_outputs");
    expect(destroy).toContain("cancel-image-creation");
    expect(destroy).toContain(
      "Name=tag:AgentFormationDeployment,Values=$DEPLOYMENT",
    );
    expect(destroy).toContain("get-bucket-tagging");
    expect(destroy.indexOf("BUCKET_POLICY_FROZEN=true")).toBeLessThan(
      destroy.lastIndexOf("aws_cli s3api put-bucket-policy"),
    );
    expect(destroy.indexOf("stop_all_provisioning_executions")).toBeLessThan(
      destroy.indexOf('delete_named_stack "$(provisioning_stack)"'),
    );
    expect(
      destroy.indexOf('delete_named_stack "$(provisioning_stack)"'),
    ).toBeLessThan(destroy.indexOf('RUNTIME_STACKS="$(list_runtime_stacks)"'));
  });

  it("retries only a concurrent registry change during disable", () => {
    const disable = readScript("users-disable.sh");
    expect(disable).toContain(
      'if [[ "$UPDATE_RESULT" != *ConditionalCheckFailedException* ]]',
    );
    expect(disable).toContain(
      'EXPECTED_RUNTIME_STACK="$(runtime_stack_name_for_subject "$USER_SUB")"',
    );
    expect(disable).toContain("REGISTRY_ITEM_PRESENT=false");
    expect(disable).not.toContain(
      'say "The user is disabled; no runtime has been created"\n    exit',
    );
    expect(disable).toContain("admin-user-global-sign-out");
    expect(disable).toContain("attribute_not_exists(userSub)");
    expect(disable).toContain('status:{S:"disabled"}');
    expect(disable).toContain(
      "SET_ACTIONS='#status = :disabled, updatedAt = :updatedAt'",
    );
    expect(disable).toContain("REMOVE_ACTIONS=");
    expect(disable).toContain("purgeLockExpiresAt");
    expect(disable).toContain('secure_instance "$INSTANCE_ID"');
    expect(disable).toContain("#instance = :observedInstance");
    expect(disable).toContain("#stack = :observedStack");
    expect(disable).toContain("#startedAt = :observedStartedAt");
    expect(
      disable.indexOf('if EARLY_STACK_INSTANCE_ID="$(stack_output_optional'),
    ).toBeLessThan(disable.indexOf('stop_provisioning_executions "$USER_SUB"'));
  });

  it("disables a Cognito user cleanly when no runtime was created", () => {
    const fixture = mkdtempSync(join(tmpdir(), "agentformation-disable-"));
    const awsMock = join(fixture, "aws");
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
case "$command" in
  *"cloudformation describe-stacks --stack-name example-foundation"*"UserPoolId"*) printf 'pool-id\\n' ;;
  *"cloudformation describe-stacks --stack-name example-foundation"*"UserRegistryTableName"*) printf 'registry-table\\n' ;;
  "cognito-idp list-users"*) printf '%s\\n' '{"Users":[{"Username":"person","Attributes":[{"Name":"email","Value":"person@example.com"},{"Name":"sub","Value":"123e4567-e89b-12d3-a456-426614174000"}]}]}' ;;
  "cognito-idp admin-get-user"*) printf '%s\\n' '{"Username":"person","Enabled":false,"UserAttributes":[{"Name":"sub","Value":"123e4567-e89b-12d3-a456-426614174000"}]}' ;;
  "cognito-idp admin-disable-user"*|"cognito-idp admin-user-global-sign-out"*) printf '%s\\n' '{}' ;;
  "dynamodb get-item"*) printf '%s\\n' '{}' ;;
  "dynamodb put-item"*) printf '%s\\n' '{}' ;;
  *"cloudformation describe-stacks --stack-name example-runtime-123e4567e89b12d3"*) printf 'ValidationError: Stack does not exist\\n' >&2; exit 255 ;;
  *"cloudformation describe-stacks --stack-name example-provisioning"*) printf 'ValidationError: Stack does not exist\\n' >&2; exit 255 ;;
  *) printf 'Unexpected mock AWS call: %s\\n' "$command" >&2; exit 64 ;;
esac
`,
    );
    chmodSync(awsMock, 0o755);

    try {
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
            AGENTFORMATION_CONFIG: configFile,
            LANG: "C",
            LC_ALL: "C",
            PATH: `${fixture}:${process.env.PATH ?? ""}`,
          },
        },
      );
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        "The user is disabled; no assigned runtime exists",
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("re-enables a user whose disabled marker has no runtime yet", () => {
    const fixture = mkdtempSync(join(tmpdir(), "agentformation-enable-"));
    const awsMock = join(fixture, "aws");
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
case "$command" in
  *"cloudformation describe-stacks --stack-name example-foundation"*"UserPoolId"*) printf 'pool-id\\n' ;;
  *"cloudformation describe-stacks --stack-name example-foundation"*"UserRegistryTableName"*) printf 'registry-table\\n' ;;
  "cognito-idp list-users"*) printf '%s\\n' '{"Users":[{"Username":"person","Attributes":[{"Name":"email","Value":"person@example.com"},{"Name":"sub","Value":"123e4567-e89b-12d3-a456-426614174000"}]}]}' ;;
  "dynamodb get-item"*) printf '%s\\n' '{"Item":{"userSub":{"S":"123e4567-e89b-12d3-a456-426614174000"},"email":{"S":"person@example.com"},"runtimeStackName":{"S":"example-runtime-123e4567e89b12d3"},"status":{"S":"disabled"},"updatedAt":{"S":"2026-08-28T00:00:00Z"}}}' ;;
  "cognito-idp admin-enable-user"*) printf '%s\\n' '{}' ;;
  "dynamodb update-item"*)
    [[ "$command" == *"attribute_not_exists(instanceId)"* ]] || exit 64
    printf '%s\\n' '{}'
    ;;
  *) printf 'Unexpected mock AWS call: %s\\n' "$command" >&2; exit 64 ;;
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
            AGENTFORMATION_CONFIG: configFile,
            LANG: "C",
            LC_ALL: "C",
            PATH: `${fixture}:${process.env.PATH ?? ""}`,
          },
        },
      );
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        "The user is enabled and can create or retry an environment",
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("purges only subject-bound runtime stacks after revoking live access", () => {
    const purge = readScript("users-purge.sh");
    expect(purge).toContain("AgentFormationUserSubject");
    expect(purge).toContain("AgentFormationDeployment");
    expect(purge).toContain('"$SCRIPT_DIR/users-disable.sh" --email "$EMAIL"');
    expect(purge).toContain('cut_off_runtime_instance "$instance_id"');
    expect(purge).toContain("--condition-expression");
    expect(
      purge.match(/\[\[ -n "\$runtime_stack" \]\] \|\| continue/g),
    ).toHaveLength(3);
    expect(purge).toContain('if delete_stack_if_present "$runtime_stack"');
    expect(purge).toContain("RECORDED_STACK_PRESENT=false");
    expect(purge).toContain("RECORDED_INSTANCE_ID_PRESENT=false");
    expect(purge.indexOf('"$SCRIPT_DIR/users-disable.sh"')).toBeLessThan(
      purge.indexOf('delete_stack_if_present "$runtime_stack"'),
    );
  });

  it("purges a Cognito user cleanly when no runtime stack or registry item exists", () => {
    const fixture = mkdtempSync(join(tmpdir(), "agentformation-purge-"));
    const awsMock = join(fixture, "aws");
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
case "$command" in
  *"cloudformation describe-stacks --stack-name example-foundation"*"UserPoolId"*) printf 'pool-id\\n' ;;
  *"cloudformation describe-stacks --stack-name example-foundation"*"UserRegistryTableName"*) printf 'registry-table\\n' ;;
  "cognito-idp list-users"*) printf '%s\\n' '{"Users":[{"Username":"person","Attributes":[{"Name":"email","Value":"person@example.com"},{"Name":"sub","Value":"123e4567-e89b-12d3-a456-426614174000"}]}]}' ;;
  "dynamodb get-item"*) printf '%s\\n' '{}' ;;
  "dynamodb put-item"*)
    if [[ "$command" == *'"status":{"S":"purged"}'* ]]; then
      [[ -f "$AF_PURGE_USER_DELETED" ]] || exit 65
      [[ "$command" == *'"expiresAt":{"N":"'* ]] || exit 66
    fi
    printf '%s\\n' '{}'
    ;;
  "cloudformation describe-stacks --output json") printf '%s\\n' '{"Stacks":[]}' ;;
  *"cloudformation describe-stacks --stack-name example-runtime-123e4567e89b12d3"*) printf 'ValidationError: Stack does not exist\\n' >&2; exit 255 ;;
  *"cloudformation describe-stacks --stack-name example-provisioning"*) printf 'ValidationError: Stack does not exist\\n' >&2; exit 255 ;;
  "cognito-idp admin-get-user"*) printf '%s\\n' '{"Username":"person","Enabled":false,"UserAttributes":[{"Name":"sub","Value":"123e4567-e89b-12d3-a456-426614174000"}]}' ;;
  "cognito-idp admin-disable-user"*|"cognito-idp admin-user-global-sign-out"*) printf '%s\\n' '{}' ;;
  "cognito-idp admin-delete-user"*)
    : >"$AF_PURGE_USER_DELETED"
    printf '%s\\n' '{}'
    ;;
  *) printf 'Unexpected mock AWS call: %s\\n' "$command" >&2; exit 64 ;;
esac
`,
    );
    chmodSync(awsMock, 0o755);
    const disableMock = join(fixture, "users-disable.sh");
    writeFileSync(disableMock, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(disableMock, 0o755);

    try {
      const scriptUnderTest = readScript("users-purge.sh").replace(
        'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
        `SCRIPT_DIR=${JSON.stringify(fixture)}`,
      );
      const purgeScript = join(fixture, "users-purge.sh");
      writeFileSync(purgeScript, scriptUnderTest);
      const libraryDirectory = join(fixture, "lib");
      mkdirSync(libraryDirectory);
      for (const library of ["common.sh", "stacks.sh"]) {
        writeFileSync(
          join(libraryDirectory, library),
          readFileSync(
            resolve(import.meta.dirname, `../../../scripts/lib/${library}`),
          ),
        );
      }
      const result = spawnSync(
        "bash",
        [purgeScript, "--email", "person@example.com", "--confirm", "DELETE"],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            AGENTFORMATION_CONFIG: configFile,
            AF_PURGE_USER_DELETED: join(fixture, "user-deleted"),
            LANG: "C",
            LC_ALL: "C",
            PATH: `${fixture}:${process.env.PATH ?? ""}`,
          },
        },
      );
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        "no managed runtime stack was present, and a short-lived access tombstone remains",
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
