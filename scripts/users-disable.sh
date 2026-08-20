#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

require_config
EMAIL="$(prompt_email "$(read_option --email "$@" || true)")"
[[ "$EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || fail "Enter a valid email address"
USER_POOL_ID="$(stack_output "$(foundation_stack)" UserPoolId)"
TABLE_NAME="$(stack_output "$(foundation_stack)" UserRegistryTableName)"
USER_SUB="$(aws_cli cognito-idp admin-get-user \
  --user-pool-id "$USER_POOL_ID" \
  --username "$EMAIL" \
  --query "UserAttributes[?Name=='sub'].Value | [0]" \
  --output text)"
[[ "$USER_SUB" != "None" && -n "$USER_SUB" ]] || fail "Cognito user was not found"

KEY="$(jq -cn --arg userSub "$USER_SUB" '{userSub:{S:$userSub}}')"
INSTANCE_ID="$(aws_cli dynamodb get-item \
  --table-name "$TABLE_NAME" \
  --key "$KEY" \
  --consistent-read \
  --query 'Item.instanceId.S' \
  --output text)"

say "Disabling sign-in before stopping the assigned runtime"
aws_cli cognito-idp admin-disable-user --user-pool-id "$USER_POOL_ID" --username "$EMAIL"
UPDATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
aws_cli dynamodb update-item \
  --table-name "$TABLE_NAME" \
  --key "$KEY" \
  --update-expression 'SET #status = :status, updatedAt = :updatedAt' \
  --expression-attribute-names '{"#status":"status"}' \
  --expression-attribute-values "$(jq -cn --arg updatedAt "$UPDATED_AT" '{":status":{S:"disabled"},":updatedAt":{S:$updatedAt}}')" >/dev/null

if [[ "$INSTANCE_ID" =~ ^i-[0-9a-f]+$ ]]; then
  aws_cli ec2 stop-instances --instance-ids "$INSTANCE_ID" >/dev/null
fi
say "The user is disabled and the runtime is stopping; its disk is preserved"
