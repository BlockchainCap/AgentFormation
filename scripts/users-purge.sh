#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"
# shellcheck source=lib/stacks.sh
source "$SCRIPT_DIR/lib/stacks.sh"

require_config
[[ "$(read_option --confirm "$@" || true)" == "DELETE" ]] || fail "Purging requires --confirm DELETE"
EMAIL="$(prompt_email "$(read_option --email "$@" || true)")"
[[ "$EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || fail "Enter a valid email address"
USER_POOL_ID="$(stack_output "$(foundation_stack)" UserPoolId)"
TABLE_NAME="$(stack_output "$(foundation_stack)" UserRegistryTableName)"
IFS=$'\t' read -r COGNITO_USERNAME USER_SUB < <(find_cognito_user_by_email "$USER_POOL_ID" "$EMAIL")

KEY="$(jq -cn --arg userSub "$USER_SUB" '{userSub:{S:$userSub}}')"
RUNTIME_STACK="$(aws_cli dynamodb get-item \
  --table-name "$TABLE_NAME" \
  --key "$KEY" \
  --consistent-read \
  --query 'Item.runtimeStackName.S' \
  --output text)"

aws_cli cognito-idp admin-disable-user --user-pool-id "$USER_POOL_ID" --username "$COGNITO_USERNAME"
stop_provisioning_executions "$USER_SUB"
if [[ "$RUNTIME_STACK" == "$(deployment_name)-runtime-"* ]]; then
  delete_stack "$RUNTIME_STACK"
fi
aws_cli dynamodb delete-item --table-name "$TABLE_NAME" --key "$KEY"
aws_cli cognito-idp admin-delete-user --user-pool-id "$USER_POOL_ID" --username "$COGNITO_USERNAME"
say "The user, runtime, and persistent runtime disk were deleted"
