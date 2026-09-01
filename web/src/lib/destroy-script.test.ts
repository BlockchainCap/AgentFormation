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

const destroyScript = resolve(
  import.meta.dirname,
  "../../../scripts/destroy.sh",
);

function runDestroy(
  scenario:
    | "read-error"
    | "foreign-image-record"
    | "untagged-ami"
    | "missing-ami"
    | "legacy-description-mismatch"
    | "foreign-foundation-stack"
    | "missing-bucket-output"
    | "untagged-bucket"
    | "multipart"
    | "delete-failure"
    | "delete-failure-no-policy"
    | "drain"
    | "drain-failure"
    | "drain-empty-response"
    | "drain-short-response"
    | "drain-pagination"
    | "drain-nonascii"
    | "drain-malformed-listing"
    | "runtime-service-role-order",
) {
  const fixture = mkdtempSync(join(tmpdir(), "agentformation-destroy-"));
  const configFile = join(fixture, "agentformation.json");
  const awsMock = join(fixture, "aws");
  const sleepMock = join(fixture, "sleep");
  writeFileSync(
    configFile,
    JSON.stringify({ deploymentName: "example", region: "us-west-2" }),
  );
  writeFileSync(sleepMock, "#!/usr/bin/env bash\nset -euo pipefail\nexit 0\n");
  writeFileSync(
    awsMock,
    `#!/usr/bin/env bash
set -euo pipefail

shift 4
service="\${1:-}"
operation="\${2:-}"
shift 2
arguments="$*"
scenario="\${AF_DESTROY_SCENARIO:?}"
state="\${AF_DESTROY_STATE:?}"

not_found() {
  printf 'ValidationError: Stack does not exist\\n' >&2
  exit 255
}

case "$service $operation" in
  "sts get-caller-identity")
    printf '%s\\n' '{"Account":"123456789012","Arn":"arn:aws:iam::123456789012:user/operator"}'
    ;;
  "cloudformation describe-stacks")
    if [[ "$arguments" == *"--stack-name example-foundation"* ]]; then
      if [[ "$scenario" != "read-error" && "$scenario" != "foreign-image-record" && "$scenario" != "untagged-ami" && "$scenario" != "missing-ami" && "$scenario" != "legacy-description-mismatch" && ! -f "$state/foundation-deleted" ]]; then
        if [[ "$arguments" == *"UploadBucketName"* ]]; then
          if [[ "$scenario" == "missing-bucket-output" ]]; then
            printf 'None\\n'
          else
            printf 'example-upload-bucket\\n'
          fi
        else
          if [[ "$scenario" == "foreign-foundation-stack" ]]; then
            printf '%s\\n' '{"Stacks":[{"StackName":"example-foundation","Tags":[{"Key":"AgentFormationDeployment","Value":"other"}]}]}'
          else
            printf '%s\\n' '{"Stacks":[{"StackName":"example-foundation","Tags":[{"Key":"AgentFormationDeployment","Value":"example"}]}]}'
          fi
        fi
      else
        not_found
      fi
    elif [[ "$scenario" == "runtime-service-role-order" && "$arguments" == *"--stack-name example-web"* ]]; then
      if [[ -f "$state/web-deleted" ]]; then
        not_found
      else
        printf '%s\\n' '{"Stacks":[{"StackName":"example-web","Tags":[{"Key":"AgentFormationDeployment","Value":"example"}]}]}'
      fi
    elif [[ "$scenario" == "runtime-service-role-order" && "$arguments" == *"--stack-name example-provisioning"* ]]; then
      if [[ -f "$state/provisioning-deleted" ]]; then
        not_found
      elif [[ "$arguments" == *"StateMachineArn"* ]]; then
        printf '%s\\n' 'arn:aws:states:us-west-2:123456789012:stateMachine:example-provisioning'
      else
        printf '%s\\n' '{"Stacks":[{"StackName":"example-provisioning","Tags":[{"Key":"AgentFormationDeployment","Value":"example"}]}]}'
      fi
    elif [[ "$scenario" == "runtime-service-role-order" && "$arguments" == *"--stack-name example-runtime-0000000000004000"* ]]; then
      if [[ -f "$state/runtime-deleted" ]]; then
        not_found
      else
        printf '%s\\n' '{"Stacks":[{"StackName":"example-runtime-0000000000004000","Tags":[{"Key":"AgentFormationDeployment","Value":"example"}]}]}'
      fi
    elif [[ "$arguments" == *"--stack-name"* ]]; then
      not_found
    elif [[ "$scenario" == "runtime-service-role-order" && ! -f "$state/runtime-deleted" ]]; then
      printf '%s\\n' '{"Stacks":[{"StackName":"example-runtime-0000000000004000","Tags":[{"Key":"AgentFormationDeployment","Value":"example"}]}]}'
    else
      printf '%s\\n' '{"Stacks":[]}'
    fi
    ;;
  "cloudformation delete-stack")
    if [[ "$scenario" == "runtime-service-role-order" && "$arguments" == *"--stack-name example-web"* ]]; then
      : >"$state/web-deleted"
    elif [[ "$scenario" == "runtime-service-role-order" && "$arguments" == *"--stack-name example-runtime-0000000000004000"* ]]; then
      if [[ -f "$state/provisioning-deleted" ]]; then
        printf 'runtime service role no longer exists\\n' >&2
        exit 70
      fi
      : >"$state/runtime-deleted"
    elif [[ "$scenario" == "runtime-service-role-order" && "$arguments" == *"--stack-name example-provisioning"* ]]; then
      [[ -f "$state/runtime-deleted" ]] || {
        printf 'runtime still depends on provisioning service role\\n' >&2
        exit 70
      }
      : >"$state/provisioning-deleted"
    else
      [[ "$arguments" == *"--stack-name example-foundation"* ]] || exit 64
      [[ -f "$state/policy-frozen" ]] || exit 65
      if [[ "$scenario" == "delete-failure" || "$scenario" == "delete-failure-no-policy" ]]; then
        printf 'simulated stack delete failure\\n' >&2
        exit 70
      fi
      if [[ "$scenario" == "multipart" ]]; then
        [[ -f "$state/multipart-aborted" ]] || exit 66
      fi
      : >"$state/foundation-deleted"
    fi
    ;;
  "cloudformation wait")
    if [[ "$scenario" != "runtime-service-role-order" ]]; then
      [[ "$arguments" == *"stack-delete-complete --stack-name example-foundation"* ]] || exit 64
    fi
    ;;
  "stepfunctions list-executions")
    [[ "$scenario" == "runtime-service-role-order" ]] || exit 64
    printf '%s\\n' '{"executions":[]}'
    ;;
  "imagebuilder list-images")
    if [[ "$scenario" == "read-error" ]]; then
      printf 'simulated image read failure\\n' >&2
      exit 70
    fi
    if [[ "$scenario" == "foreign-image-record" ]]; then
      printf '%s\\n' '{"imageVersionList":[{"name":"example-image-recipe","owner":"999999999999","arn":"arn:aws:imagebuilder:us-west-2:999999999999:image/example-image-recipe/1.0.0"}]}'
    elif [[ ( "$scenario" == "untagged-ami" || "$scenario" == "missing-ami" || "$scenario" == "legacy-description-mismatch" ) && ! -f "$state/image-record-deleted" ]]; then
      printf '%s\\n' '{"imageVersionList":[{"name":"example-image-recipe","owner":"123456789012","arn":"arn:aws:imagebuilder:us-west-2:123456789012:image/example-image-recipe/1.0.0"}]}'
    else
      printf '%s\\n' '{"imageVersionList":[]}'
    fi
    ;;
  "imagebuilder list-image-build-versions")
    printf '%s\\n' '{"imageSummaryList":[{"name":"example-image-recipe","owner":"123456789012","arn":"arn:aws:imagebuilder:us-west-2:123456789012:image/example-image-recipe/1.0.0/1","state":{"status":"AVAILABLE"},"outputResources":{"amis":[{"region":"us-west-2","accountId":"123456789012","image":"ami-1234abcd"}]}}]}'
    ;;
  "imagebuilder delete-image")
    [[ "$arguments" == *"ami-1234abcd"* || "$arguments" == *"example-image-recipe/1.0.0/1"* ]] || exit 64
    : >"$state/image-record-deleted"
    ;;
  "ec2 describe-images")
    if [[ "$arguments" == *"--image-ids ami-1234abcd"* ]]; then
      if [[ "$scenario" == "missing-ami" || "$scenario" == "legacy-description-mismatch" ]]; then
        printf 'InvalidAMIID.NotFound\\n' >&2
        exit 255
      fi
      printf '%s\\n' '{"Images":[{"ImageId":"ami-1234abcd","OwnerId":"123456789012","BlockDeviceMappings":[{"Ebs":{"SnapshotId":"snap-1234abcd"}}]}]}'
    else
      printf '%s\\n' '{"Images":[]}'
    fi
    ;;
  "ec2 describe-snapshots")
    if [[ "$scenario" == "missing-ami" && "$arguments" == *"Name=description"* ]]; then
      printf '%s\\n' '{"Snapshots":[{"SnapshotId":"snap-1234abcd","Description":"Created by CreateImage(i-1234abcd) for ami-1234abcd"}]}'
    elif [[ "$scenario" == "legacy-description-mismatch" && "$arguments" == *"Name=description"* ]]; then
      printf '%s\\n' '{"Snapshots":[{"SnapshotId":"snap-1234abcd","Description":"unrelated backup that mentions ami-1234abcd"}]}'
    else
      printf '%s\\n' '{"Snapshots":[]}'
    fi
    ;;
  "ec2 deregister-image")
    [[ "$arguments" == *"--image-id ami-1234abcd"* ]] || exit 64
    : >"$state/ami-deregistered"
    ;;
  "ec2 delete-snapshot")
    [[ "$arguments" == *"--snapshot-id snap-1234abcd"* ]] || exit 64
    : >"$state/snapshot-deleted"
    ;;
  "s3api get-bucket-tagging")
    [[ "$arguments" == *"--expected-bucket-owner 123456789012"* ]] || exit 64
    if [[ "$scenario" == "untagged-bucket" ]]; then
      printf '%s\\n' '{"TagSet":[{"Key":"AgentFormationDeployment","Value":"other"}]}'
    else
      printf '%s\\n' '{"TagSet":[{"Key":"AgentFormationDeployment","Value":"example"}]}'
    fi
    ;;
  "s3api get-bucket-policy")
    if [[ "$scenario" == "delete-failure" ]]; then
      printf '%s\\n' '{"Version":"2012-10-17","Statement":[{"Sid":"ExistingReadPolicy","Effect":"Allow","Principal":"*","Action":"s3:GetObject","Resource":"arn:aws:s3:::example-upload-bucket/*"},{"Sid":"DenyNewUploadsDuringTeardown","Effect":"Deny","Principal":"*","Action":"s3:PutObject","Resource":"arn:aws:s3:::example-upload-bucket/*"}]}'
    else
      printf 'NoSuchBucketPolicy\\n' >&2
      exit 255
    fi
    ;;
  "s3api put-bucket-policy")
    [[ "$arguments" == *"--expected-bucket-owner 123456789012"* ]] || exit 64
    if [[ "$arguments" == *"DenyNewUploadsDuringTeardown"* ]]; then
      : >"$state/policy-frozen"
    else
      [[ "$scenario" == "delete-failure" ]] || exit 67
      [[ "$arguments" == *"ExistingReadPolicy"* ]] || exit 68
      : >"$state/policy-restored"
    fi
    ;;
  "s3api delete-bucket-policy")
    [[ "$arguments" == *"--expected-bucket-owner 123456789012"* ]] || exit 64
    : >"$state/policy-deleted"
    ;;
  "s3api list-multipart-uploads")
    [[ "$arguments" == *"--expected-bucket-owner 123456789012"* ]] || exit 64
    if [[ "$scenario" == "multipart" && ! -f "$state/multipart-aborted" ]]; then
      printf '%s\\n' '{"Uploads":[{"Key":"incomplete upload.bin","UploadId":"upload-1"}]}'
    else
      printf '%s\\n' '{"Uploads":[]}'
    fi
    ;;
  "s3api abort-multipart-upload")
    key_argument_found=false
    for argument in "$@"; do
      [[ "$argument" == "--key=incomplete upload.bin" ]] && key_argument_found=true
    done
    [[ "$key_argument_found" == "true" ]] || exit 64
    [[ "$arguments" == *"--upload-id=upload-1"* ]] || exit 64
    [[ "$arguments" == *"--expected-bucket-owner 123456789012"* ]] || exit 64
    [[ -f "$state/policy-frozen" ]] || exit 65
    : >"$state/multipart-aborted"
    ;;
  "s3api list-object-versions")
    if [[ "$scenario" == "drain-pagination" && ! -f "$state/page-1-deleted" ]]; then
      printf '%s\\n' '{"Versions":[{"Key":"page one.txt","VersionId":"version-1"}]}'
    elif [[ "$scenario" == "drain-pagination" && ! -f "$state/page-2-deleted" ]]; then
      printf '%s\\n' '{"DeleteMarkers":[{"Key":"page two.txt","VersionId":"marker-2"}]}'
    elif [[ ( "$scenario" == "drain" || "$scenario" == "drain-failure" || "$scenario" == "drain-empty-response" || "$scenario" == "drain-short-response" ) && ! -f "$state/objects-deleted" ]]; then
      printf '%s\\n' '{"Versions":[{"Key":"plain object.txt","VersionId":"null"}],"DeleteMarkers":[{"Key":"old object.txt","VersionId":"marker-1"}]}'
    elif [[ "$scenario" == "drain-nonascii" && ! -f "$state/objects-deleted" ]]; then
      printf '%s\\n' '{"Versions":[{"Key":"résumé—Q3.pdf","VersionId":"version-1"}]}'
    elif [[ "$scenario" == "drain-malformed-listing" ]]; then
      printf '%s\\n' '{"Versions":{"Key":"not-an-array","VersionId":"version-1"}}'
    else
      printf '%s\\n' '{}'
    fi
    ;;
  "s3api delete-objects")
    [[ "$arguments" == *"--delete file:///dev/stdin"* ]] || exit 64
    delete_request="$(cat)"
    [[ "$delete_request" == *'"Quiet":false'* ]] || exit 64
    if [[ "$scenario" == "drain-pagination" && "$delete_request" == *'"Key":"page one.txt"'* ]]; then
      : >"$state/page-1-deleted"
      printf '%s\\n' '{"Deleted":[{"Key":"page one.txt","VersionId":"version-1"}]}'
    elif [[ "$scenario" == "drain-pagination" && "$delete_request" == *'"Key":"page two.txt"'* ]]; then
      [[ -f "$state/page-1-deleted" ]] || exit 65
      : >"$state/page-2-deleted"
      printf '%s\\n' '{"Deleted":[{"Key":"page two.txt","VersionId":"marker-2"}]}'
    elif [[ "$scenario" == "drain-failure" ]]; then
      [[ "$delete_request" == *'"Key":"plain object.txt","VersionId":"null"'* ]] || exit 64
      printf '%s\\n' '{"Errors":[{"Key":"plain object.txt","VersionId":"null","Code":"AccessDenied"}]}'
    elif [[ "$scenario" == "drain-empty-response" ]]; then
      printf ''
    elif [[ "$scenario" == "drain-short-response" ]]; then
      printf '%s\\n' '{"Deleted":[{"Key":"plain object.txt","VersionId":"null"}]}'
    elif [[ "$scenario" == "drain-nonascii" ]]; then
      [[ "$delete_request" == *'r\\u00e9sum\\u00e9\\u2014Q3.pdf'* ]] || exit 64
      : >"$state/objects-deleted"
      printf '%s\\n' '{"Deleted":[{"Key":"résumé—Q3.pdf","VersionId":"version-1"}]}'
    else
      [[ "$delete_request" == *'"Key":"plain object.txt","VersionId":"null"'* ]] || exit 64
      [[ "$delete_request" == *'"Key":"old object.txt","VersionId":"marker-1"'* ]] || exit 64
      : >"$state/objects-deleted"
      printf '%s\\n' '{"Deleted":[{"Key":"plain object.txt","VersionId":"null"},{"Key":"old object.txt","VersionId":"marker-1"}]}'
    fi
    ;;
  *)
    printf 'Unexpected mock AWS call: %s %s %s\\n' "$service" "$operation" "$arguments" >&2
    exit 64
    ;;
esac
`,
  );
  chmodSync(awsMock, 0o755);
  chmodSync(sleepMock, 0o755);

  const result = spawnSync("bash", [destroyScript, "--confirm", "DELETE"], {
    encoding: "utf8",
    env: {
      ...process.env,
      AF_DESTROY_SCENARIO: scenario,
      AF_DESTROY_STATE: fixture,
      AGENTFORMATION_CONFIG: configFile,
      AWS_DEFAULT_REGION: "us-west-2",
      AWS_REGION: "us-west-2",
      LANG: "C",
      LC_ALL: "C",
      PATH: `${fixture}:${process.env.PATH ?? ""}`,
    },
  });

  return {
    fixture,
    result,
    wasCreated(name: string) {
      return existsSync(join(fixture, name));
    },
  };
}

describe("destroy script convergence", () => {
  it("deletes runtimes before removing their CloudFormation service role", () => {
    const run = runDestroy("runtime-service-role-order");
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.wasCreated("runtime-deleted")).toBe(true);
      expect(run.wasCreated("provisioning-deleted")).toBe(true);
      expect(run.result.stdout).toContain(
        "AgentFormation AWS resources were deleted",
      );
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  });

  it("fails closed when Image Builder cannot be read", () => {
    const run = runDestroy("read-error");
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain("simulated image read failure");
      expect(run.result.stdout).not.toContain(
        "AgentFormation AWS resources were deleted",
      );
      expect(run.wasCreated("foundation-deleted")).toBe(false);
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  });

  it("deletes an untagged AMI proven to belong to the deployment by Image Builder", () => {
    const run = runDestroy("untagged-ami");
    try {
      expect(run.result.stderr).toBe("");
      expect(run.result.status).toBe(0);
      expect(run.wasCreated("ami-deregistered")).toBe(true);
      expect(run.wasCreated("snapshot-deleted")).toBe(true);
      expect(run.wasCreated("image-record-deleted")).toBe(true);
      expect(run.result.stdout).toContain(
        "AgentFormation AWS resources were deleted",
      );
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  });

  it("uses an exact AWS CreateImage description only after the AMI is gone", () => {
    const run = runDestroy("missing-ami");
    try {
      expect(run.result.stderr).toBe("");
      expect(run.result.status).toBe(0);
      expect(run.wasCreated("ami-deregistered")).toBe(false);
      expect(run.wasCreated("snapshot-deleted")).toBe(true);
      expect(run.wasCreated("image-record-deleted")).toBe(true);
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  });

  it("rejects a snapshot description that merely mentions the missing AMI", () => {
    const run = runDestroy("legacy-description-mismatch");
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain(
        "EC2 returned an unrelated legacy snapshot",
      );
      expect(run.wasCreated("snapshot-deleted")).toBe(false);
      expect(run.wasCreated("image-record-deleted")).toBe(false);
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  });

  it("rejects an Image Builder record from another account", () => {
    const run = runDestroy("foreign-image-record");
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain(
        "Image Builder returned an image version outside this deployment",
      );
      expect(run.wasCreated("image-record-deleted")).toBe(false);
      expect(run.wasCreated("foundation-deleted")).toBe(false);
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  });

  it("rejects an upload bucket tagged for another deployment before freezing it", () => {
    const run = runDestroy("untagged-bucket");
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain(
        "The upload bucket is not tagged for this deployment",
      );
      expect(run.wasCreated("policy-frozen")).toBe(false);
      expect(run.wasCreated("foundation-deleted")).toBe(false);
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  });

  it("rejects a named foundation stack tagged for another deployment", () => {
    const run = runDestroy("foreign-foundation-stack");
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain(
        "The named stack is not tagged for this deployment",
      );
      expect(run.wasCreated("policy-frozen")).toBe(false);
      expect(run.wasCreated("foundation-deleted")).toBe(false);
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  });

  it("fails closed when the required upload-bucket output is missing", () => {
    const run = runDestroy("missing-bucket-output");
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain(
        "did not return the required UploadBucketName output",
      );
      expect(run.wasCreated("policy-frozen")).toBe(false);
      expect(run.wasCreated("foundation-deleted")).toBe(false);
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  });

  it("aborts incomplete multipart uploads before deleting the bucket stack", () => {
    const run = runDestroy("multipart");
    try {
      expect(run.result.stderr).toBe("");
      expect(run.result.status).toBe(0);
      expect(run.wasCreated("multipart-aborted")).toBe(true);
      expect(run.wasCreated("foundation-deleted")).toBe(true);
      expect(run.result.stdout).toContain(
        "AgentFormation AWS resources were deleted",
      );
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  });

  it("drains null versions and delete markers before deleting the bucket stack", () => {
    const run = runDestroy("drain");
    try {
      expect(run.result.stderr).toBe("");
      expect(run.result.status).toBe(0);
      expect(run.wasCreated("objects-deleted")).toBe(true);
      expect(run.wasCreated("foundation-deleted")).toBe(true);
      expect(run.result.stdout).toContain(
        "AgentFormation AWS resources were deleted",
      );
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  });

  it("re-lists the first page until every version page is drained", () => {
    const run = runDestroy("drain-pagination");
    try {
      expect(run.result.stderr).toBe("");
      expect(run.result.status).toBe(0);
      expect(run.wasCreated("page-1-deleted")).toBe(true);
      expect(run.wasCreated("page-2-deleted")).toBe(true);
      expect(run.wasCreated("foundation-deleted")).toBe(true);
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  });

  it("uses an ASCII-safe delete request for non-ASCII object keys", () => {
    const run = runDestroy("drain-nonascii");
    try {
      expect(run.result.stderr).toBe("");
      expect(run.result.status).toBe(0);
      expect(run.wasCreated("objects-deleted")).toBe(true);
      expect(run.wasCreated("foundation-deleted")).toBe(true);
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  });

  it("fails closed on a malformed version listing", () => {
    const run = runDestroy("drain-malformed-listing");
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.wasCreated("policy-deleted")).toBe(true);
      expect(run.wasCreated("foundation-deleted")).toBe(false);
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  });

  it("restores the temporary policy when an object version cannot be deleted", () => {
    const run = runDestroy("drain-failure");
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain(
        "Some versioned upload bucket objects could not be deleted",
      );
      expect(run.wasCreated("policy-deleted")).toBe(true);
      expect(run.wasCreated("foundation-deleted")).toBe(false);
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  });

  it.each([
    ["empty", "drain-empty-response"],
    ["short", "drain-short-response"],
  ] as const)(
    "fails closed and restores the policy after an %s delete response",
    (_description, scenario) => {
      const run = runDestroy(scenario);
      try {
        expect(run.result.status).not.toBe(0);
        expect(run.result.stderr).toContain(
          "Some versioned upload bucket objects could not be deleted",
        );
        expect(run.wasCreated("policy-deleted")).toBe(true);
        expect(run.wasCreated("foundation-deleted")).toBe(false);
      } finally {
        rmSync(run.fixture, { recursive: true, force: true });
      }
    },
  );

  it("restores the bucket policy and stops when stack deletion fails", () => {
    const run = runDestroy("delete-failure");
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain("simulated stack delete failure");
      expect(run.wasCreated("policy-frozen")).toBe(true);
      expect(run.wasCreated("policy-restored")).toBe(true);
      expect(run.wasCreated("foundation-deleted")).toBe(false);
      expect(run.result.stdout).not.toContain(
        "AgentFormation AWS resources were deleted",
      );
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  });

  it("removes a temporary deny policy after stack deletion fails on a bucket with no original policy", () => {
    const run = runDestroy("delete-failure-no-policy");
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain("simulated stack delete failure");
      expect(run.wasCreated("policy-frozen")).toBe(true);
      expect(run.wasCreated("policy-deleted")).toBe(true);
      expect(run.wasCreated("foundation-deleted")).toBe(false);
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  });
});
