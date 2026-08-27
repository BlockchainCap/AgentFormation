#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"
# shellcheck source=lib/stacks.sh
source "$SCRIPT_DIR/lib/stacks.sh"

require_config
[[ "$(read_option --confirm "$@" || true)" == "DELETE" ]] || fail "Destroying the deployment requires --confirm DELETE"
CALLER_IDENTITY="$(aws_cli sts get-caller-identity --output json)"
ACCOUNT_ID="$(jq -er '.Account | select(test("^[0-9]{12}$"))' <<<"$CALLER_IDENTITY")"
AWS_PARTITION="$(jq -er '.Arn | split(":")[1] | select(test("^aws(-[a-z]+)?$"))' <<<"$CALLER_IDENTITY")"
DEPLOYMENT="$(deployment_name)"

assert_named_stack_owned() {
  local stack="$1"
  local description
  description="$(aws_cli cloudformation describe-stacks \
    --stack-name "$stack" \
    --output json)" || return 1
  jq -e --arg stack "$stack" --arg deployment "$DEPLOYMENT" '
    (.Stacks // []) | length == 1 and
    .[0].StackName == $stack and
    any(.[0].Tags[]?;
      .Key == "AgentFormationDeployment" and .Value == $deployment)
  ' <<<"$description" >/dev/null || \
    fail "The named stack is not tagged for this deployment: $stack"
}

delete_named_stack() {
  local stack="$1"
  local stack_status
  if stack_exists "$stack"; then
    assert_named_stack_owned "$stack"
    delete_stack "$stack"
    return
  else
    stack_status=$?
  fi
  [[ "$stack_status" -eq 1 ]] || return "$stack_status"
}

list_runtime_stacks() {
  local stacks
  stacks="$(aws_cli cloudformation describe-stacks --output json)" || return 1
  jq -er --arg prefix "$DEPLOYMENT-runtime-" --arg deployment "$DEPLOYMENT" '
    [.Stacks[]? | select(.StackName | startswith($prefix))] as $candidates
    | if ([$candidates[] | select(
        ([.Tags[]? | select(.Key == "AgentFormationDeployment" and .Value == $deployment)] | length) == 0
      )] | length) > 0
      then error("a runtime-prefix stack is not tagged for this deployment")
      else [$candidates[].StackName] | unique
      end
  ' <<<"$stacks"
}

list_deployment_image_builds() {
  local recipe_name="$DEPLOYMENT-image-recipe"
  local arn_prefix aws_region
  local image_versions version_arns version_arn build_versions new_builds
  local builds='[]'
  aws_region="$(region)" || return 1
  arn_prefix="arn:$AWS_PARTITION:imagebuilder:$aws_region:$ACCOUNT_ID:image/$recipe_name/"

  image_versions="$(aws_cli imagebuilder list-images \
    --owner Self \
    --include-deprecated \
    --filters "name=name,values=$recipe_name" \
    --output json)" || return 1
  jq -e --arg recipe "$recipe_name" --arg owner "$ACCOUNT_ID" --arg prefix "$arn_prefix" '
    (.imageVersionList // []) | all(.[];
      .name == $recipe and .owner == $owner and (.arn | startswith($prefix)))
  ' <<<"$image_versions" >/dev/null || fail "Image Builder returned an image version outside this deployment"
  version_arns="$(jq -er '[.imageVersionList[]?.arn] | unique | join("\n")' <<<"$image_versions")" || return 1

  while IFS= read -r version_arn; do
    [[ -n "$version_arn" ]] || continue
    [[ "$version_arn" == "$arn_prefix"* ]] || fail "Image Builder returned an invalid image version ARN"
    build_versions="$(aws_cli imagebuilder list-image-build-versions \
      --image-version-arn "$version_arn" \
      --output json)" || return 1
    jq -e --arg recipe "$recipe_name" --arg owner "$ACCOUNT_ID" --arg prefix "$arn_prefix" '
      (.imageSummaryList // []) | all(.[];
        .name == $recipe and .owner == $owner and (.arn | startswith($prefix)))
    ' <<<"$build_versions" >/dev/null || fail "Image Builder returned an image build outside this deployment"
    new_builds="$(jq -ce '(.imageSummaryList // []) | select(type == "array")' <<<"$build_versions")" || return 1
    builds="$(jq -cn --argjson current "$builds" --argjson additions "$new_builds" \
      '$current + $additions | unique_by(.arn)')" || return 1
  done <<<"$version_arns"

  printf '%s\n' "$builds"
}

quiesce_image_builder_outputs() {
  local builds active_arns image_arn cancel_result
  local quiet_passes=0 attempt=1

  say "Stopping any Image Builder work before removing images"
  while [[ "$attempt" -le 120 ]]; do
    builds="$(list_deployment_image_builds)" || return 1
    jq -e 'type == "array"' <<<"$builds" >/dev/null || return 1
    active_arns="$(jq -er '[.[] | select(
      (.state.status // "") as $status |
      (["AVAILABLE", "CANCELLED", "FAILED", "DEPRECATED", "DELETED", "DISABLED"] | index($status)) == null
    ) | .arn] | unique | join("\n")' <<<"$builds")" || return 1
    if [[ -z "$active_arns" ]]; then
      quiet_passes=$((quiet_passes + 1))
      say "Confirming Image Builder is quiet ($quiet_passes/5)"
      [[ "$quiet_passes" -ge 5 ]] && return 0
      sleep 30
    else
      quiet_passes=0
      while IFS= read -r image_arn; do
        [[ -n "$image_arn" ]] || continue
        if ! cancel_result="$(aws_cli imagebuilder cancel-image-creation \
          --image-build-version-arn "$image_arn" 2>&1)"; then
          if [[ "$cancel_result" != *InvalidRequestException* && \
            "$cancel_result" != *ResourceNotFoundException* ]]; then
            printf '%s\n' "$cancel_result" >&2
            return 1
          fi
        fi
      done <<<"$active_arns"
      say "Waiting for Image Builder cancellation to finish"
      sleep 15
    fi
    attempt=$((attempt + 1))
  done

  printf 'ERROR: Image Builder did not become quiet before the teardown deadline\n' >&2
  return 1
}

delete_deployment_image_outputs() {
  local builds builder_ami_ids builder_ami_id image_result image_error image_missing
  local tagged_images image_descriptions tagged_snapshots legacy_snapshots
  local all_legacy_snapshots='[]'
  local ami_ids ami_id snapshot_ids snapshot_id image_arns image_arn
  local deregister_result delete_result delete_image_result remaining_builds
  local remaining_build_count remaining_ami_count remaining_snapshot_count quiet_passes attempt aws_region

  builds="$(list_deployment_image_builds)" || return 1
  aws_region="$(region)" || return 1
  jq -e --arg region "$aws_region" --arg account "$ACCOUNT_ID" '
    all(.[].outputResources.amis[]?;
      .region == $region and .accountId == $account and
      (.image | test("^ami-([0-9a-f]{8}|[0-9a-f]{17})$")))
  ' <<<"$builds" >/dev/null || fail "Image Builder returned an AMI outside this account and region"
  builder_ami_ids="$(jq -er '[.[].outputResources.amis[]?.image] | unique | join("\n")' <<<"$builds")"
  tagged_images="$(aws_cli ec2 describe-images \
    --owners self \
    --filters "Name=tag:AgentFormationDeployment,Values=$DEPLOYMENT" \
    --output json)" || return 1
  jq -e --arg deployment "$DEPLOYMENT" '
    (.Images // []) | all(.[];
      any(.Tags[]?; .Key == "AgentFormationDeployment" and .Value == $deployment))
  ' <<<"$tagged_images" >/dev/null || fail "EC2 returned an AMI outside this deployment"
  image_descriptions="$(jq -c '.Images // []' <<<"$tagged_images")"

  while IFS= read -r builder_ami_id; do
    [[ -n "$builder_ami_id" ]] || continue
    [[ "$builder_ami_id" =~ ^ami-([0-9a-f]{8}|[0-9a-f]{17})$ ]] || fail "Image Builder returned an invalid AMI ID"
    image_missing=false
    if ! jq -e --arg ami "$builder_ami_id" 'any(.[]; .ImageId == $ami)' <<<"$image_descriptions" >/dev/null; then
      if ! image_result="$(aws_cli ec2 describe-images --image-ids "$builder_ami_id" --output json 2>&1)"; then
        image_error="$image_result"
        if [[ "$image_error" != *InvalidAMIID.NotFound* && "$image_error" != *InvalidAMIID.Unavailable* ]]; then
          printf '%s\n' "$image_error" >&2
          return 1
        fi
        image_missing=true
      else
        # The validated Image Builder record is the authority for older or
        # partially completed deployments whose imperative EC2 tags are absent.
        jq -e --arg ami "$builder_ami_id" --arg owner "$ACCOUNT_ID" '
          (.Images // []) | length == 1 and
          .[0].ImageId == $ami and
          .[0].OwnerId == $owner
        ' <<<"$image_result" >/dev/null || fail "An Image Builder AMI is outside this AWS account"
        image_descriptions="$(jq -cn --argjson current "$image_descriptions" --argjson additions "$(jq -c '.Images' <<<"$image_result")" \
          '$current + $additions | unique_by(.ImageId)')"
      fi
    fi

    # Older AgentFormation releases did not explicitly tag EBS snapshots.
    # Use the AWS-documented CreateImage description only when the validated
    # Image Builder AMI has already disappeared and its block-device mapping
    # can no longer identify the snapshots from the source of truth.
    if [[ "$image_missing" == "true" ]]; then
      legacy_snapshots="$(aws_cli ec2 describe-snapshots \
        --owner-ids self \
        --filters "Name=description,Values=Created by CreateImage(*) for $builder_ami_id*" \
        --output json)" || return 1
      jq -e --arg ami "$builder_ami_id" '
        (.Snapshots // []) | all(.[];
          (.Description // "") |
          test("^Created by CreateImage\\(i-(?:[0-9a-f]{8}|[0-9a-f]{17})\\) for " + $ami + "(?: from vol-(?:[0-9a-f]{8}|[0-9a-f]{17}))?$")
        )
      ' <<<"$legacy_snapshots" >/dev/null || fail "EC2 returned an unrelated legacy snapshot"
      all_legacy_snapshots="$(jq -cn \
        --argjson current "$all_legacy_snapshots" \
        --argjson additions "$(jq -c '.Snapshots // []' <<<"$legacy_snapshots")" \
        '$current + $additions | unique_by(.SnapshotId)')" || return 1
    fi
  done <<<"$builder_ami_ids"

  tagged_snapshots="$(aws_cli ec2 describe-snapshots \
    --owner-ids self \
    --filters "Name=tag:AgentFormationDeployment,Values=$DEPLOYMENT" \
    --output json)"
  jq -e --arg deployment "$DEPLOYMENT" '
    (.Snapshots // []) | all(.[];
      any(.Tags[]?; .Key == "AgentFormationDeployment" and .Value == $deployment))
  ' <<<"$tagged_snapshots" >/dev/null || fail "EC2 returned a snapshot outside this deployment"

  ami_ids="$(jq -er '[.[].ImageId] | unique | join("\n")' <<<"$image_descriptions")"
  snapshot_ids="$(jq -nre \
    --argjson images "$image_descriptions" \
    --argjson tagged "$tagged_snapshots" \
    --argjson legacy "$all_legacy_snapshots" '
      ([
        $images[]?.BlockDeviceMappings[]?.Ebs.SnapshotId,
        $tagged.Snapshots[]?.SnapshotId,
        $legacy[]?.SnapshotId
      ] | map(select(type == "string")) | unique | join("\n"))
    ')"

  while IFS= read -r ami_id; do
    [[ -n "$ami_id" ]] || continue
    [[ "$ami_id" =~ ^ami-([0-9a-f]{8}|[0-9a-f]{17})$ ]] || fail "EC2 returned an invalid deployment AMI ID"
    if ! deregister_result="$(aws_cli ec2 deregister-image --image-id "$ami_id" 2>&1)"; then
      if [[ "$deregister_result" != *InvalidAMIID.NotFound* && "$deregister_result" != *InvalidAMIID.Unavailable* ]]; then
        printf '%s\n' "$deregister_result" >&2
        return 1
      fi
    fi
  done <<<"$ami_ids"

  while IFS= read -r snapshot_id; do
    [[ -n "$snapshot_id" ]] || continue
    [[ "$snapshot_id" =~ ^snap-([0-9a-f]{8}|[0-9a-f]{17})$ ]] || fail "EC2 returned an invalid deployment snapshot ID"
    attempt=1
    while true; do
      if delete_result="$(aws_cli ec2 delete-snapshot --snapshot-id "$snapshot_id" 2>&1)"; then
        break
      fi
      if [[ "$delete_result" == *InvalidSnapshot.NotFound* ]]; then
        break
      fi
      if [[ "$delete_result" == *InvalidSnapshot.InUse* && "$attempt" -lt 30 ]]; then
        sleep 2
        attempt=$((attempt + 1))
        continue
      fi
      printf '%s\n' "$delete_result" >&2
      return 1
    done
  done <<<"$snapshot_ids"

  image_arns="$(jq -er '[.[].arn] | unique | join("\n")' <<<"$builds")"
  while IFS= read -r image_arn; do
    [[ -n "$image_arn" ]] || continue
    if ! delete_image_result="$(aws_cli imagebuilder delete-image \
      --image-build-version-arn "$image_arn" 2>&1)"; then
      if [[ "$delete_image_result" != *ResourceNotFoundException* ]]; then
        printf '%s\n' "$delete_image_result" >&2
        return 1
      fi
    fi
  done <<<"$image_arns"

  attempt=1
  quiet_passes=0
  while [[ "$attempt" -le 30 ]]; do
    remaining_builds="$(list_deployment_image_builds)" || return 1
    tagged_images="$(aws_cli ec2 describe-images \
      --owners self \
      --filters "Name=tag:AgentFormationDeployment,Values=$DEPLOYMENT" \
      --output json)" || return 1
    tagged_snapshots="$(aws_cli ec2 describe-snapshots \
      --owner-ids self \
      --filters "Name=tag:AgentFormationDeployment,Values=$DEPLOYMENT" \
      --output json)" || return 1
    remaining_build_count="$(jq -er 'length' <<<"$remaining_builds")"
    remaining_ami_count="$(jq -er '(.Images // []) | length' <<<"$tagged_images")"
    remaining_snapshot_count="$(jq -er '(.Snapshots // []) | length' <<<"$tagged_snapshots")"
    [[ "$remaining_build_count" =~ ^[0-9]+$ && \
      "$remaining_ami_count" =~ ^[0-9]+$ && \
      "$remaining_snapshot_count" =~ ^[0-9]+$ ]] || \
      fail "AWS returned an invalid image cleanup count"
    if [[ "$remaining_build_count" -eq 0 && \
      "$remaining_ami_count" -eq 0 && \
      "$remaining_snapshot_count" -eq 0 ]]; then
      quiet_passes=$((quiet_passes + 1))
      [[ "$quiet_passes" -ge 2 ]] && return 0
    else
      quiet_passes=0
    fi
    [[ "$attempt" -lt 30 ]] || fail "Image Builder or EC2 image resources remained after cleanup"
    sleep 2
    attempt=$((attempt + 1))
  done

}

empty_upload_bucket() {
  local bucket="$1"
  local account_id="$2"
  local multipart_listing multipart_uploads multipart_lines multipart_count multipart_upload
  local upload_key upload_id abort_result multipart_attempt=1
  local version_listing version_delete_request version_count version_attempt=1
  local delete_result

  # Incomplete multipart uploads are not objects or versions, but they still
  # keep S3 from deleting the bucket. The temporary bucket policy prevents new
  # uploads while this loop repeatedly drains the first page.
  while true; do
    multipart_listing="$(aws_cli s3api list-multipart-uploads \
      --bucket "$bucket" \
      --max-uploads 1000 \
      --no-paginate \
      --expected-bucket-owner "$account_id" \
      --output json)" || return 1
    multipart_uploads="$(jq -ce '(.Uploads // []) | select(type == "array")' \
      <<<"$multipart_listing")" || return 1
    multipart_count="$(jq -er 'length' <<<"$multipart_uploads")" || return 1
    multipart_lines="$(jq -c '.[]' <<<"$multipart_uploads")" || return 1
    [[ "$multipart_count" =~ ^[0-9]+$ ]] || fail "S3 returned an invalid multipart upload count"
    [[ "$multipart_count" -gt 0 ]] || break

    while IFS= read -r multipart_upload; do
      [[ -n "$multipart_upload" ]] || continue
      upload_key="$(jq -er '.Key | select(type == "string" and length > 0)' \
        <<<"$multipart_upload")" || return 1
      upload_id="$(jq -er '.UploadId | select(type == "string" and length > 0)' \
        <<<"$multipart_upload")" || return 1
      if ! abort_result="$(aws_cli s3api abort-multipart-upload \
        --bucket "$bucket" \
        --key="$upload_key" \
        --upload-id="$upload_id" \
        --expected-bucket-owner "$account_id" 2>&1)"; then
        if [[ "$abort_result" != *NoSuchUpload* ]]; then
          printf '%s\n' "$abort_result" >&2
          return 1
        fi
      fi
    done <<<"$multipart_lines"
    [[ "$multipart_attempt" -lt 120 ]] || \
      fail "Multipart uploads did not drain before the teardown deadline"
    multipart_attempt=$((multipart_attempt + 1))
  done

  # Delete every version and delete marker. S3 exposes objects from an
  # unversioned bucket here with VersionId "null", so one loop safely covers
  # both the default bucket and a bucket whose operator enabled versioning.
  # --no-paginate keeps each delete at S3's 1,000-object request limit.
  while true; do
    version_listing="$(aws_cli s3api list-object-versions \
      --bucket "$bucket" \
      --max-keys 1000 \
      --no-paginate \
      --expected-bucket-owner "$account_id" \
      --output json)" || return 1
    version_delete_request="$(jq -cae '
      (.Versions // []) as $versions |
      (.DeleteMarkers // []) as $markers |
      if ($versions | type) == "array" and ($markers | type) == "array"
      then {Objects: (
        [$versions[] | {Key, VersionId}] +
        [$markers[] | {Key, VersionId}]
      ), Quiet: false}
      else error("S3 returned malformed object-version arrays")
      end
    ' <<<"$version_listing")" || return 1
    version_count="$(jq -er '.Objects | length' <<<"$version_delete_request")" || return 1
    [[ "$version_count" =~ ^[0-9]+$ ]] || fail "S3 returned an invalid version count"
    [[ "$version_count" -gt 0 ]] || break
    delete_result="$(printf '%s' "$version_delete_request" | \
      aws_cli s3api delete-objects \
        --bucket "$bucket" \
        --expected-bucket-owner "$account_id" \
        --delete file:///dev/stdin \
        --output json)" || return 1
    jq -e --argjson requested "$version_count" '
      ((.Errors // []) | length) == 0 and
      ((.Deleted // []) | length) == $requested
    ' <<<"$delete_result" >/dev/null || \
      fail "Some versioned upload bucket objects could not be deleted"
    [[ "$version_attempt" -lt 120 ]] || \
      fail "Object versions did not drain before the teardown deadline"
    version_attempt=$((version_attempt + 1))
  done

}

assert_no_runtime_stacks() {
  local remaining remaining_count quiet_passes=0
  while [[ "$quiet_passes" -lt 2 ]]; do
    remaining="$(list_runtime_stacks)"
    remaining_count="$(jq -er 'length' <<<"$remaining")"
    [[ "$remaining_count" =~ ^[0-9]+$ ]] || fail "CloudFormation returned an invalid runtime stack count"
    [[ "$remaining_count" -eq 0 ]] || fail "A runtime stack reappeared during teardown"
    quiet_passes=$((quiet_passes + 1))
    [[ "$quiet_passes" -ge 2 ]] || sleep 2
  done
}

# Remove the browser first so no new provisioning request can be accepted.
delete_named_stack "$(web_stack)"

# Then stop every already-running workflow and remove the state machine before
# taking the authoritative runtime-stack snapshot.
stop_all_provisioning_executions || fail "Provisioning executions could not be stopped; teardown did not continue"
delete_named_stack "$(provisioning_stack)"

RUNTIME_STACKS="$(list_runtime_stacks)"
while IFS= read -r runtime_stack; do
  [[ -n "$runtime_stack" ]] || continue
  delete_stack "$runtime_stack"
done <<<"$(jq -r '.[]' <<<"$RUNTIME_STACKS")"
assert_no_runtime_stacks

IMAGE_STACK_PRESENT=false
if stack_exists "$(image_stack)"; then
  assert_named_stack_owned "$(image_stack)"
  IMAGE_STACK_PRESENT=true
else
  stack_status=$?
  [[ "$stack_status" -eq 1 ]] || exit "$stack_status"
fi
quiesce_image_builder_outputs || fail "Image Builder could not be stopped; teardown did not continue"
delete_deployment_image_outputs
if [[ "$IMAGE_STACK_PRESENT" == "true" ]]; then
  delete_stack "$(image_stack)"
fi

if stack_exists "$(foundation_stack)"; then
  assert_named_stack_owned "$(foundation_stack)"
  # Every supported foundation stack owns an upload bucket. Without this
  # required output, teardown cannot prove or drain that bucket safely.
  BUCKET="$(stack_output "$(foundation_stack)" UploadBucketName)"
  [[ "$BUCKET" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ && "$BUCKET" != *..* ]] || \
    fail "The foundation stack returned an invalid upload bucket name"
  BUCKET_TAGS="$(aws_cli s3api get-bucket-tagging \
    --bucket "$BUCKET" \
    --expected-bucket-owner "$ACCOUNT_ID" \
    --output json)"
  jq -e --arg deployment "$DEPLOYMENT" '
    any(.TagSet[]?; .Key == "AgentFormationDeployment" and .Value == $deployment)
  ' <<<"$BUCKET_TAGS" >/dev/null || fail "The upload bucket is not tagged for this deployment"
  ORIGINAL_BUCKET_POLICY_PRESENT=true
  if ! POLICY_RESULT="$(aws_cli s3api get-bucket-policy \
    --bucket "$BUCKET" \
    --expected-bucket-owner "$ACCOUNT_ID" \
    --query Policy \
    --output text 2>&1)"; then
    if [[ "$POLICY_RESULT" == *NoSuchBucketPolicy* ]]; then
      ORIGINAL_BUCKET_POLICY_PRESENT=false
      POLICY_RESULT='{"Version":"2012-10-17","Statement":[]}'
    else
      printf '%s\n' "$POLICY_RESULT" >&2
      fail "The upload bucket policy could not be read"
    fi
  fi
  ORIGINAL_BUCKET_POLICY="$(jq -ce '
    .Statement = ((.Statement // []) | if type == "array" then . else [.] end
      | map(select(.Sid != "DenyNewUploadsDuringTeardown")))
  ' <<<"$POLICY_RESULT")"
  ORIGINAL_STATEMENT_COUNT="$(jq -er '.Statement | length' <<<"$ORIGINAL_BUCKET_POLICY")"
  [[ "$ORIGINAL_STATEMENT_COUNT" =~ ^[0-9]+$ ]] || fail "The upload bucket policy has an invalid statement count"
  if [[ "$ORIGINAL_STATEMENT_COUNT" -eq 0 ]]; then
    ORIGINAL_BUCKET_POLICY_PRESENT=false
  fi
  FREEZE_POLICY="$(jq -ce \
    --arg partition "$AWS_PARTITION" \
    --arg bucket "$BUCKET" \
    '.Statement += [{Sid:"DenyNewUploadsDuringTeardown",Effect:"Deny",Principal:"*",Action:"s3:PutObject",Resource:("arn:"+$partition+":s3:::"+$bucket+"/*")}]' \
    <<<"$ORIGINAL_BUCKET_POLICY")"
  BUCKET_POLICY_FROZEN=false
  FOUNDATION_REMOVED=false
  restore_bucket_policy() {
    local exit_status=$?
    trap - EXIT
    trap '' INT TERM HUP QUIT
    if [[ "$BUCKET_POLICY_FROZEN" == "true" && "$FOUNDATION_REMOVED" != "true" ]]; then
      say "Restoring the upload bucket policy after an incomplete teardown"
      if [[ "$ORIGINAL_BUCKET_POLICY_PRESENT" == "true" ]]; then
        if ! aws_cli s3api put-bucket-policy \
          --bucket "$BUCKET" \
          --expected-bucket-owner "$ACCOUNT_ID" \
          --policy "$ORIGINAL_BUCKET_POLICY"; then
          printf 'ERROR: The original upload bucket policy could not be restored\n' >&2
          exit 1
        fi
      elif ! aws_cli s3api delete-bucket-policy \
        --bucket "$BUCKET" \
        --expected-bucket-owner "$ACCOUNT_ID"; then
        printf 'ERROR: The temporary upload bucket policy could not be removed\n' >&2
        exit 1
      fi
    fi
    exit "$exit_status"
  }
  trap restore_bucket_policy EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 131' QUIT
  trap 'exit 143' TERM
  BUCKET_POLICY_FROZEN=true
  aws_cli s3api put-bucket-policy \
    --bucket "$BUCKET" \
    --expected-bucket-owner "$ACCOUNT_ID" \
    --policy "$FREEZE_POLICY"
  empty_upload_bucket "$BUCKET" "$ACCOUNT_ID"
  # The foundation template owns an EmptyOnDelete ECR repository, so
  # CloudFormation handles image pagination and partial failures itself.
  delete_stack "$(foundation_stack)"
  FOUNDATION_REMOVED=true
  BUCKET_POLICY_FROZEN=false
  trap - EXIT INT TERM HUP QUIT
else
  stack_status=$?
  [[ "$stack_status" -eq 1 ]] || exit "$stack_status"
fi

delete_named_stack "$(network_stack)"

say "AgentFormation AWS resources were deleted"
