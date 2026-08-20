#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"
# shellcheck source=lib/stacks.sh
source "$SCRIPT_DIR/lib/stacks.sh"

require_config
EMAIL="$(prompt_email "$(read_option --email "$@" || true)")"
[[ "$EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || fail "Enter a valid email address"

SUPPRESS_INVITE=false
for argument in "$@"; do
  [[ "$argument" == "--suppress-invite" ]] && SUPPRESS_INVITE=true
done

USER_POOL_ID="$(stack_output "$(foundation_stack)" UserPoolId)"
TABLE_NAME="$(stack_output "$(foundation_stack)" UserRegistryTableName)"
UPLOAD_BUCKET="$(stack_output "$(foundation_stack)" UploadBucketName)"

if aws_cli cognito-idp admin-get-user --user-pool-id "$USER_POOL_ID" --username "$EMAIL" >/dev/null 2>&1; then
  say "The Cognito user already exists; keeping the current invitation state"
else
  CREATE_ARGUMENTS=(
    cognito-idp admin-create-user
    --user-pool-id "$USER_POOL_ID"
    --username "$EMAIL"
    --user-attributes "Name=email,Value=$EMAIL" "Name=email_verified,Value=true"
  )
  if [[ "$SUPPRESS_INVITE" == "true" ]]; then
    CREATE_ARGUMENTS+=(--message-action SUPPRESS)
    say "Creating the test user without sending an invitation"
  else
    say "Creating the user and sending a Cognito invitation"
  fi
  aws_cli "${CREATE_ARGUMENTS[@]}" >/dev/null
fi

aws_cli cognito-idp admin-enable-user --user-pool-id "$USER_POOL_ID" --username "$EMAIL"
USER_SUB="$(aws_cli cognito-idp admin-get-user \
  --user-pool-id "$USER_POOL_ID" \
  --username "$EMAIL" \
  --query "UserAttributes[?Name=='sub'].Value | [0]" \
  --output text)"
[[ "$USER_SUB" != "None" && -n "$USER_SUB" ]] || fail "Cognito did not return a user subject"

RUNTIME_SUFFIX="$(hash_text "$USER_SUB" | cut -c1-12)"
RUNTIME_STACK="$(deployment_name)-runtime-$RUNTIME_SUFFIX"
deploy_stack "$RUNTIME_STACK" templates/runtime.yaml \
  DeploymentName="$(deployment_name)" \
  NetworkStackName="$(network_stack)" \
  UserSubject="$USER_SUB" \
  AmiParameterPath="$(ami_parameter_path)" \
  InstanceType="$(config '.runtime.instanceType')" \
  Architecture="$(config '.runtime.architecture')" \
  VolumeSizeGiB="$(config '.runtime.volumeSizeGiB')" \
  ClaudeModelId="$(config '.models.claude')" \
  CodexModelId="$(config '.models.codex')" \
  UploadBucketName="$UPLOAD_BUCKET"

INSTANCE_ID="$(stack_output "$RUNTIME_STACK" InstanceId)"
INSTANCE_STATE="$(aws_cli ec2 describe-instances \
  --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].State.Name' \
  --output text)"
if [[ "$INSTANCE_STATE" == "stopping" ]]; then
  say "Waiting for the existing runtime to stop before restarting it"
  aws_cli ec2 wait instance-stopped --instance-ids "$INSTANCE_ID"
  INSTANCE_STATE="stopped"
fi
if [[ "$INSTANCE_STATE" == "stopped" ]]; then
  say "Restarting the existing runtime"
  aws_cli ec2 start-instances --instance-ids "$INSTANCE_ID" >/dev/null
fi
UPDATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
ITEM="$(jq -cn \
  --arg userSub "$USER_SUB" \
  --arg email "$EMAIL" \
  --arg instanceId "$INSTANCE_ID" \
  --arg stackName "$RUNTIME_STACK" \
  --arg updatedAt "$UPDATED_AT" \
  '{userSub:{S:$userSub},email:{S:$email},instanceId:{S:$instanceId},runtimeStackName:{S:$stackName},status:{S:"active"},updatedAt:{S:$updatedAt}}')"
aws_cli dynamodb put-item --table-name "$TABLE_NAME" --item "$ITEM"

say "The user now has one private runtime assigned"
