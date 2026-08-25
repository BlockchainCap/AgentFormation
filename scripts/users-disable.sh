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
USER_POOL_ID="$(stack_output "$(foundation_stack)" UserPoolId)"
TABLE_NAME="$(stack_output "$(foundation_stack)" UserRegistryTableName)"
IFS=$'\t' read -r COGNITO_USERNAME USER_SUB < <(find_cognito_user_by_email "$USER_POOL_ID" "$EMAIL")

KEY="$(jq -cn --arg userSub "$USER_SUB" '{userSub:{S:$userSub}}')"
RUNTIME="$(aws_cli dynamodb get-item \
  --table-name "$TABLE_NAME" \
  --key "$KEY" \
  --consistent-read \
  --output json)"
STATUS="$(jq -r '.Item.status.S // ""' <<<"$RUNTIME")"
INSTANCE_ID="$(jq -r '.Item.instanceId.S // ""' <<<"$RUNTIME")"
RUNTIME_STACK="$(jq -r '.Item.runtimeStackName.S // ""' <<<"$RUNTIME")"

say "Disabling company sign-in before changing the assigned runtime"
aws_cli cognito-idp admin-disable-user --user-pool-id "$USER_POOL_ID" --username "$COGNITO_USERNAME"
UPDATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [[ -z "$STATUS" ]]; then
  say "The user is disabled; no runtime has been created"
  exit
fi

if [[ "$STATUS" == "provisioning" ]]; then
  aws_cli dynamodb update-item \
    --table-name "$TABLE_NAME" \
    --key "$KEY" \
    --update-expression 'SET #status = :failed, updatedAt = :updatedAt' \
    --condition-expression '#status = :provisioning' \
    --expression-attribute-names '{"#status":"status"}' \
    --expression-attribute-values "$(jq -cn --arg updatedAt "$UPDATED_AT" '{":failed":{S:"failed"},":provisioning":{S:"provisioning"},":updatedAt":{S:$updatedAt}}')" >/dev/null
  stop_provisioning_executions "$USER_SUB"
  if [[ "$RUNTIME_STACK" == "$(deployment_name)-runtime-"* ]]; then
    delete_stack "$RUNTIME_STACK"
  fi
  say "The user is disabled and the unfinished runtime was removed"
  exit
fi

if [[ "$STATUS" == "active" || "$STATUS" == "disabled" ]]; then
  aws_cli dynamodb update-item \
    --table-name "$TABLE_NAME" \
    --key "$KEY" \
    --update-expression 'SET #status = :disabled, updatedAt = :updatedAt' \
    --expression-attribute-names '{"#status":"status"}' \
    --expression-attribute-values "$(jq -cn --arg updatedAt "$UPDATED_AT" '{":disabled":{S:"disabled"},":updatedAt":{S:$updatedAt}}')" >/dev/null
fi

if [[ "$INSTANCE_ID" =~ ^i-[0-9a-f]+$ ]]; then
  aws_cli ec2 stop-instances --instance-ids "$INSTANCE_ID" >/dev/null
fi
if [[ "$STATUS" == "active" || "$STATUS" == "disabled" ]]; then
  say "The user is disabled and the runtime is stopping; its disk is preserved"
else
  say "The user is disabled; there is no active runtime to stop"
fi
