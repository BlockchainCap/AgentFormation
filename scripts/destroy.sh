#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"
# shellcheck source=lib/stacks.sh
source "$SCRIPT_DIR/lib/stacks.sh"

require_config
[[ "$(read_option --confirm "$@" || true)" == "DELETE" ]] || fail "Destroying the deployment requires --confirm DELETE"

delete_stack "$(web_stack)"

if aws_cli cloudformation describe-stacks --stack-name "$(foundation_stack)" >/dev/null 2>&1; then
  TABLE_NAME="$(stack_output "$(foundation_stack)" UserRegistryTableName)"
  while IFS= read -r RUNTIME_STACK; do
    [[ "$RUNTIME_STACK" == "$(deployment_name)-runtime-"* ]] || continue
    delete_stack "$RUNTIME_STACK"
  done < <(aws_cli dynamodb scan --table-name "$TABLE_NAME" --projection-expression runtimeStackName --query 'Items[].runtimeStackName.S' --output text | tr '\t' '\n')
fi

if aws_cli cloudformation describe-stacks --stack-name "$(image_stack)" >/dev/null 2>&1; then
  PIPELINE_ARN="$(stack_output "$(image_stack)" ImagePipelineArn)"
  while IFS= read -r IMAGE_ARN; do
    [[ -n "$IMAGE_ARN" ]] || continue
    while IFS= read -r AMI_ID; do
      [[ "$AMI_ID" =~ ^ami-[0-9a-f]+$ ]] || continue
      SNAPSHOT_IDS="$(aws_cli ec2 describe-images --image-ids "$AMI_ID" --query 'Images[].BlockDeviceMappings[].Ebs.SnapshotId' --output text 2>/dev/null || true)"
      aws_cli ec2 deregister-image --image-id "$AMI_ID" || true
      for snapshot_id in $SNAPSHOT_IDS; do
        [[ "$snapshot_id" =~ ^snap-[0-9a-f]+$ ]] || continue
        aws_cli ec2 delete-snapshot --snapshot-id "$snapshot_id" || true
      done
    done < <(aws_cli imagebuilder get-image --image-build-version-arn "$IMAGE_ARN" --query 'image.outputResources.amis[].image' --output text | tr '\t' '\n')
    aws_cli imagebuilder delete-image --image-build-version-arn "$IMAGE_ARN" || true
  done < <(aws_cli imagebuilder list-image-pipeline-images --image-pipeline-arn "$PIPELINE_ARN" --query 'imageSummaryList[].arn' --output text | tr '\t' '\n')
  delete_stack "$(image_stack)"
fi

if aws_cli cloudformation describe-stacks --stack-name "$(foundation_stack)" >/dev/null 2>&1; then
  BUCKET="$(stack_output "$(foundation_stack)" UploadBucketName)"
  REPOSITORY="$(stack_output "$(foundation_stack)" WebRepositoryName)"
  aws_cli s3 rm "s3://$BUCKET" --recursive
  IMAGE_IDS="$(aws_cli ecr list-images --repository-name "$REPOSITORY" --query 'imageIds' --output json)"
  if [[ "$(jq 'length' <<<"$IMAGE_IDS")" -gt 0 ]]; then
    aws_cli ecr batch-delete-image --repository-name "$REPOSITORY" --image-ids "$IMAGE_IDS" >/dev/null
  fi
  delete_stack "$(foundation_stack)"
fi

delete_stack "$(network_stack)"

say "AgentFormation AWS resources were deleted"
