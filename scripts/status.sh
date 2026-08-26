#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

require_config
say "Shared stacks"
for stack in "$(network_stack)" "$(foundation_stack)" "$(image_stack)" "$(provisioning_stack)" "$(web_stack)"; do
  STATUS="$(aws_cli cloudformation describe-stacks --stack-name "$stack" --query 'Stacks[0].StackStatus' --output text 2>/dev/null || printf 'NOT_DEPLOYED')"
  printf '%-32s %s\n' "$stack" "$STATUS"
done

if aws_cli cloudformation describe-stacks --stack-name "$(foundation_stack)" >/dev/null 2>&1; then
  TABLE_NAME="$(stack_output "$(foundation_stack)" UserRegistryTableName)"
  say "Assigned runtimes"
  aws_cli dynamodb scan \
    --table-name "$TABLE_NAME" \
    --projection-expression 'email,instanceId,runtimeStackName,#status,updatedAt' \
    --expression-attribute-names '{"#status":"status"}' \
    --query 'Items[].{email:email.S,instance:instanceId.S,stack:runtimeStackName.S,status:status.S,updated:updatedAt.S}' \
    --output table
fi

if aws_cli cloudformation describe-stacks --stack-name "$(web_stack)" >/dev/null 2>&1; then
  PUBLIC_URL="$(config '(.publicUrl // "") | rtrimstr("/")')"
  if [[ -z "$PUBLIC_URL" ]]; then
    PUBLIC_URL="$(stack_output "$(web_stack)" ServiceUrl)"
  fi
  say "Web address: $PUBLIC_URL"
fi
