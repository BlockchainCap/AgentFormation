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
IFS=$'\t' read -r COGNITO_USERNAME USER_SUB < <(find_cognito_user_by_email "$USER_POOL_ID" "$EMAIL")

KEY="$(jq -cn --arg userSub "$USER_SUB" '{userSub:{S:$userSub}}')"
RUNTIME="$(aws_cli dynamodb get-item \
  --table-name "$TABLE_NAME" \
  --key "$KEY" \
  --consistent-read \
  --output json)"
INSTANCE_ID="$(jq -r '.Item.instanceId.S // ""' <<<"$RUNTIME")"
STATUS="$(jq -r '.Item.status.S // ""' <<<"$RUNTIME")"

if [[ -z "$STATUS" || "$STATUS" == "failed" ]]; then
  aws_cli cognito-idp admin-enable-user --user-pool-id "$USER_POOL_ID" --username "$COGNITO_USERNAME"
  say "The user is enabled and can create or retry an environment"
  exit
fi

if [[ "$STATUS" == "active" ]]; then
  aws_cli cognito-idp admin-enable-user --user-pool-id "$USER_POOL_ID" --username "$COGNITO_USERNAME"
  say "The user is enabled and the runtime is already active"
  exit
fi

[[ "$STATUS" == "disabled" ]] || fail "That runtime is not ready to be enabled"
[[ "$INSTANCE_ID" =~ ^i-[0-9a-f]+$ ]] || fail "The disabled runtime does not have a valid instance ID"

say "Starting the preserved runtime before restoring sign-in"
aws_cli ec2 start-instances --instance-ids "$INSTANCE_ID" >/dev/null
aws_cli cognito-idp admin-enable-user --user-pool-id "$USER_POOL_ID" --username "$COGNITO_USERNAME"
UPDATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if ! aws_cli dynamodb update-item \
  --table-name "$TABLE_NAME" \
  --key "$KEY" \
  --update-expression 'SET #status = :active, updatedAt = :updatedAt' \
  --condition-expression '#status = :disabled' \
  --expression-attribute-names '{"#status":"status"}' \
  --expression-attribute-values "$(jq -cn --arg updatedAt "$UPDATED_AT" '{":active":{S:"active"},":disabled":{S:"disabled"},":updatedAt":{S:$updatedAt}}')" >/dev/null; then
  aws_cli cognito-idp admin-disable-user --user-pool-id "$USER_POOL_ID" --username "$COGNITO_USERNAME" || true
  fail "The runtime changed while it was being enabled; sign-in remains disabled"
fi
say "The user is enabled and the preserved runtime is starting"
