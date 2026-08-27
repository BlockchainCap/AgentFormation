#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"
# shellcheck source=lib/stacks.sh
source "$SCRIPT_DIR/lib/stacks.sh"

require_config
[[ "$(read_option --confirm "$@" || true)" == "DELETE" ]] || fail "Purging requires --confirm DELETE"
EMAIL="$(normalize_email "$(prompt_email "$(read_option --email "$@" || true)")")"
[[ "$EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || fail "Enter a valid email address"
say "Revoking live access before resolving permanent deletion targets"
"$SCRIPT_DIR/users-disable.sh" --email "$EMAIL"
USER_POOL_ID="$(stack_output "$(foundation_stack)" UserPoolId)"
TABLE_NAME="$(stack_output "$(foundation_stack)" UserRegistryTableName)"
COGNITO_USER="$(find_cognito_user_by_email "$USER_POOL_ID" "$EMAIL")"
IFS=$'\t' read -r COGNITO_USERNAME USER_SUB <<<"$COGNITO_USER"
is_user_subject "$USER_SUB" || fail "Cognito returned an invalid federated subject"
EXPECTED_RUNTIME_STACK="$(runtime_stack_name_for_subject "$USER_SUB")"
DEPLOYMENT="$(deployment_name)"
KEY="$(jq -cn --arg userSub "$USER_SUB" '{userSub:{S:$userSub}}')"

RUNTIME="$(aws_cli dynamodb get-item \
  --table-name "$TABLE_NAME" \
  --key "$KEY" \
  --consistent-read \
  --output json)"
REGISTRY_ITEM_PRESENT=false
RECORDED_STACK_PRESENT=false
RECORDED_INSTANCE_ID_PRESENT=false
RECORDED_STACK=""
RECORDED_INSTANCE_ID=""
RECORDED_STATUS=""
RECORDED_UPDATED_AT=""
if [[ "$(jq '(.Item // {}) | length' <<<"$RUNTIME")" != "0" ]]; then
  REGISTRY_ITEM_PRESENT=true
  RECORDED_STATUS="$(jq -er '
    .Item.status |
    if type == "object" and (.S | type == "string") then .S
    else error("invalid status") end
  ' <<<"$RUNTIME")" || fail "The runtime registry contains an invalid status; nothing was deleted"
  [[ "$RECORDED_STATUS" == "disabled" ]] || \
    fail "The runtime changed after access was revoked; nothing was deleted"
  RECORDED_UPDATED_AT="$(jq -er '
    .Item.updatedAt |
    if type == "object" and (.S | type == "string") then .S
    else error("invalid updatedAt") end
  ' <<<"$RUNTIME")" || fail "The runtime registry contains an invalid update time; nothing was deleted"
  if jq -e '.Item | has("runtimeStackName")' <<<"$RUNTIME" >/dev/null; then
    RECORDED_STACK_PRESENT=true
    RECORDED_STACK="$(jq -er '
      .Item.runtimeStackName |
      if type == "object" and (.S | type == "string") then .S
      else error("invalid runtimeStackName") end
    ' <<<"$RUNTIME")" || fail "The runtime registry contains an invalid stack name; nothing was deleted"
  fi
  if jq -e '.Item | has("instanceId")' <<<"$RUNTIME" >/dev/null; then
    RECORDED_INSTANCE_ID_PRESENT=true
    RECORDED_INSTANCE_ID="$(jq -er '
      .Item.instanceId |
      if type == "object" and (.S | type == "string") then .S
      else error("invalid instanceId") end
    ' <<<"$RUNTIME")" || fail "The runtime registry contains an invalid instance ID; nothing was deleted"
    is_instance_id "$RECORDED_INSTANCE_ID" || \
      fail "The runtime registry contains an invalid instance ID; nothing was deleted"
  fi
fi

# Find every stack that CloudFormation tags for this deployment and subject.
# This catches an older stack name without trusting a registry value as a
# deletion target.
ALL_STACKS="$(aws_cli cloudformation describe-stacks --output json)"
MATCHING_STACKS="$(jq -cer \
  --arg deployment "$DEPLOYMENT" \
  --arg subject "$USER_SUB" '
    [.Stacks[]? | select(
      any(.Tags[]?; .Key == "AgentFormationDeployment" and .Value == $deployment) and
      any(.Tags[]?; .Key == "AgentFormationUserSubject" and .Value == $subject)
    ) | .StackName] | unique
  ' <<<"$ALL_STACKS")"

if stack_exists "$EXPECTED_RUNTIME_STACK"; then
  jq -e --arg stack "$EXPECTED_RUNTIME_STACK" 'index($stack) != null' <<<"$MATCHING_STACKS" >/dev/null || \
    fail "The expected runtime stack is not tagged for this user; nothing was deleted"
else
  stack_status=$?
  [[ "$stack_status" -eq 1 ]] || exit "$stack_status"
fi

if [[ "$RECORDED_STACK_PRESENT" == "true" && -n "$RECORDED_STACK" ]]; then
  if [[ "$RECORDED_STACK" != "$EXPECTED_RUNTIME_STACK" ]] && \
    ! jq -e --arg stack "$RECORDED_STACK" 'index($stack) != null' <<<"$MATCHING_STACKS" >/dev/null; then
    fail "The registry names a runtime stack that is not tagged for this user; nothing was deleted"
  fi
fi

while IFS= read -r runtime_stack; do
  [[ -n "$runtime_stack" ]] || continue
  [[ "$runtime_stack" == "$DEPLOYMENT-runtime-"* ]] || \
    fail "A subject-tagged stack falls outside this deployment's runtime namespace; nothing was deleted"
done <<<"$(jq -r '.[]' <<<"$MATCHING_STACKS")"

STACK_INSTANCE_IDS='[]'
while IFS= read -r runtime_stack; do
  [[ -n "$runtime_stack" ]] || continue
  if stack_instance_id="$(stack_output_optional "$runtime_stack" InstanceId)"; then
    :
  else
    fail "A runtime stack could not be inspected; nothing was deleted"
  fi
  if [[ -n "$stack_instance_id" ]]; then
    is_instance_id "$stack_instance_id" || fail "A runtime stack returned an invalid instance ID; nothing was deleted"
    STACK_INSTANCE_IDS="$(jq -c --arg instance "$stack_instance_id" '. + [$instance] | unique' <<<"$STACK_INSTANCE_IDS")"
  fi
done <<<"$(jq -r '.[]' <<<"$MATCHING_STACKS")"

if [[ "$RECORDED_INSTANCE_ID_PRESENT" == "true" ]] && \
  ! jq -e --arg instance "$RECORDED_INSTANCE_ID" 'index($instance) != null' <<<"$STACK_INSTANCE_IDS" >/dev/null; then
  if ! RECORDED_INSTANCE="$(aws_cli ec2 describe-instances \
    --instance-ids "$RECORDED_INSTANCE_ID" \
    --output json 2>&1)"; then
    if [[ "$RECORDED_INSTANCE" != *InvalidInstanceID.NotFound* ]]; then
      printf '%s\n' "$RECORDED_INSTANCE" >&2
      fail "The registry instance could not be verified; nothing was deleted"
    fi
  elif [[ "$(jq -r '.Reservations[0].Instances[0].State.Name // "None"' <<<"$RECORDED_INSTANCE")" != "terminated" ]]; then
    fail "The registry names a live instance outside every managed runtime stack; nothing was deleted"
  fi
fi
INSTANCE_IDS="$STACK_INSTANCE_IDS"

say "Confirming every subject-bound runtime is stopped before deletion"
while IFS= read -r instance_id; do
  [[ -n "$instance_id" ]] || continue
  cut_off_runtime_instance "$instance_id" || fail "The assigned runtime could not be stopped; nothing else was deleted"
done <<<"$(jq -r '.[]' <<<"$INSTANCE_IDS")"
stop_provisioning_executions "$USER_SUB" || fail "Provisioning could not be stopped; no runtime pointers were deleted"

# Lock the exact disabled registry record before any irreversible deletion.
# users-enable.sh refuses every enable path while this lock exists. A later
# users-disable.sh can remove it only after the two-hour recovery deadline.
PURGE_LOCK="$(date -u +%Y%m%dT%H%M%SZ)-$$"
PURGE_LOCK_EXPIRES_AT="$(( $(date +%s) + 2 * 60 * 60 ))"
if [[ "$REGISTRY_ITEM_PRESENT" == "true" ]]; then
  LOCK_VALUES="$(jq -cn \
    --arg updatedAt "$RECORDED_UPDATED_AT" \
    --arg purge "$PURGE_LOCK" \
    --arg purgeExpires "$PURGE_LOCK_EXPIRES_AT" \
    '{":disabled":{S:"disabled"},":updatedAt":{S:$updatedAt},":purge":{S:$purge},":purgeExpires":{N:$purgeExpires}}')"
  LOCK_CONDITION='#status = :disabled AND #updatedAt = :updatedAt AND attribute_not_exists(#purge) AND attribute_not_exists(#purgeExpires)'
  if [[ "$RECORDED_STACK_PRESENT" == "true" ]]; then
    LOCK_CONDITION+=' AND #stack = :stack'
    LOCK_VALUES="$(jq -c --arg stack "$RECORDED_STACK" '. + {":stack":{S:$stack}}' <<<"$LOCK_VALUES")"
  else
    LOCK_CONDITION+=' AND attribute_not_exists(#stack)'
  fi
  if [[ "$RECORDED_INSTANCE_ID_PRESENT" == "true" ]]; then
    LOCK_CONDITION+=' AND #instance = :instance'
    LOCK_VALUES="$(jq -c --arg instance "$RECORDED_INSTANCE_ID" '. + {":instance":{S:$instance}}' <<<"$LOCK_VALUES")"
  else
    LOCK_CONDITION+=' AND attribute_not_exists(#instance)'
  fi
  if ! aws_cli dynamodb update-item \
    --table-name "$TABLE_NAME" \
    --key "$KEY" \
    --update-expression 'SET #purge = :purge, #purgeExpires = :purgeExpires' \
    --condition-expression "$LOCK_CONDITION" \
    --expression-attribute-names '{"#status":"status","#updatedAt":"updatedAt","#stack":"runtimeStackName","#instance":"instanceId","#purge":"purgeLock","#purgeExpires":"purgeLockExpiresAt"}' \
    --expression-attribute-values "$LOCK_VALUES" >/dev/null; then
    fail "The runtime changed before purge could lock it; nothing was deleted"
  fi
else
  RECORDED_STATUS=disabled
  RECORDED_UPDATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  RECORDED_STACK_PRESENT=true
  RECORDED_STACK="$EXPECTED_RUNTIME_STACK"
  TOMBSTONE_ITEM="$(jq -cn \
    --arg userSub "$USER_SUB" \
    --arg email "$EMAIL" \
    --arg stack "$RECORDED_STACK" \
    --arg updatedAt "$RECORDED_UPDATED_AT" \
    --arg purge "$PURGE_LOCK" \
    --arg purgeExpires "$PURGE_LOCK_EXPIRES_AT" '
      {userSub:{S:$userSub},email:{S:$email},runtimeStackName:{S:$stack},status:{S:"disabled"},updatedAt:{S:$updatedAt},purgeLock:{S:$purge},purgeLockExpiresAt:{N:$purgeExpires}}
    ')"
  if ! aws_cli dynamodb put-item \
    --table-name "$TABLE_NAME" \
    --item "$TOMBSTONE_ITEM" \
    --condition-expression 'attribute_not_exists(userSub)' >/dev/null; then
    fail "The runtime changed before purge could lock it; nothing was deleted"
  fi
  REGISTRY_ITEM_PRESENT=true
fi

read_cognito_state() {
  aws_cli cognito-idp admin-get-user \
    --user-pool-id "$USER_POOL_ID" \
    --username "$COGNITO_USERNAME" \
    --output json
}

cognito_state_is_disabled() {
  local cognito_state="$1"
  jq -e \
    --arg username "$COGNITO_USERNAME" \
    --arg subject "$USER_SUB" '
      .Username == $username and
      .Enabled == false and
      any(.UserAttributes[]?; .Name == "sub" and .Value == $subject)
    ' <<<"$cognito_state" >/dev/null
}

release_purge_lock() {
  local release_values
  release_values="$(jq -cn \
    --arg purge "$PURGE_LOCK" \
    --arg purgeExpires "$PURGE_LOCK_EXPIRES_AT" \
    '{":disabled":{S:"disabled"},":purge":{S:$purge},":purgeExpires":{N:$purgeExpires}}')"
  aws_cli dynamodb update-item \
    --table-name "$TABLE_NAME" \
    --key "$KEY" \
    --update-expression 'REMOVE #purge, #purgeExpires' \
    --condition-expression '#status = :disabled AND #purge = :purge AND #purgeExpires = :purgeExpires' \
    --expression-attribute-names '{"#status":"status","#purge":"purgeLock","#purgeExpires":"purgeLockExpiresAt"}' \
    --expression-attribute-values "$release_values" >/dev/null
}

if ! COGNITO_STATE="$(read_cognito_state)"; then
  fail "Company sign-in status could not be confirmed before purge; the purge lock was preserved"
fi
if ! cognito_state_is_disabled "$COGNITO_STATE"; then
  if ! release_purge_lock; then
    fail "Company sign-in changed before purge, and the purge lock could not be released safely"
  fi
  fail "Company sign-in was re-enabled before purge; nothing was deleted and the purge lock was released"
fi

REMOVED_RUNTIME=false
while IFS= read -r runtime_stack; do
  [[ -n "$runtime_stack" ]] || continue
  if delete_stack_if_present "$runtime_stack"; then
    REMOVED_RUNTIME=true
  else
    delete_status=$?
    [[ "$delete_status" -eq 1 ]] || exit "$delete_status"
  fi
done <<<"$(jq -r '.[]' <<<"$MATCHING_STACKS")"

# With Cognito disabled and matching executions quiesced, no runtime stack may
# reappear between deletion and removal of the registry pointer.
REMAINING_STACKS="$(aws_cli cloudformation describe-stacks --output json | jq -cer \
  --arg deployment "$DEPLOYMENT" \
  --arg subject "$USER_SUB" '
    [.Stacks[]? | select(
      any(.Tags[]?; .Key == "AgentFormationDeployment" and .Value == $deployment) and
      any(.Tags[]?; .Key == "AgentFormationUserSubject" and .Value == $subject)
    )] | length
  ')"
[[ "$REMAINING_STACKS" -eq 0 ]] || fail "A runtime stack reappeared during purge; the registry and user were preserved"
if stack_exists "$EXPECTED_RUNTIME_STACK"; then
  fail "The expected runtime stack reappeared during purge; the registry and user were preserved"
else
  stack_status=$?
  [[ "$stack_status" -eq 1 ]] || exit "$stack_status"
fi

if ! COGNITO_STATE="$(read_cognito_state)" || ! cognito_state_is_disabled "$COGNITO_STATE"; then
  fail "Company sign-in changed during purge; the deleted runtime and locked registry record were preserved"
fi

# Delete the federated profile while the purge-locked registry record still
# exists. This closes the only cross-service gap where users-enable.sh could
# otherwise recreate a registry marker after its deletion but before Cognito
# deletion. If the final conditional registry delete fails, the locked record
# remains fail-closed for an identity that no longer exists.
if ! aws_cli cognito-idp admin-delete-user \
  --user-pool-id "$USER_POOL_ID" \
  --username "$COGNITO_USERNAME"; then
  fail "Cognito did not confirm permanent profile deletion; the locked registry record was preserved"
fi

if [[ "$REGISTRY_ITEM_PRESENT" == "true" ]]; then
  PURGED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  TOMBSTONE_EXPIRES_AT="$(( $(date +%s) + 2 * 60 * 60 ))"
  TOMBSTONE_VALUES="$(jq -cn --arg updatedAt "$RECORDED_UPDATED_AT" \
    --arg purge "$PURGE_LOCK" \
    --arg purgeExpires "$PURGE_LOCK_EXPIRES_AT" \
    '{":disabled":{S:"disabled"},":updatedAt":{S:$updatedAt},":purge":{S:$purge},":purgeExpires":{N:$purgeExpires}}')"
  TOMBSTONE_CONDITION='#status = :disabled AND #updatedAt = :updatedAt AND #purge = :purge AND #purgeExpires = :purgeExpires'
  if [[ "$RECORDED_STACK_PRESENT" == "true" ]]; then
    TOMBSTONE_CONDITION+=' AND #stack = :stack'
    TOMBSTONE_VALUES="$(jq -c --arg stack "$RECORDED_STACK" '. + {":stack":{S:$stack}}' <<<"$TOMBSTONE_VALUES")"
  else
    TOMBSTONE_CONDITION+=' AND attribute_not_exists(#stack)'
  fi
  if [[ "$RECORDED_INSTANCE_ID_PRESENT" == "true" ]]; then
    TOMBSTONE_CONDITION+=' AND #instance = :instance'
    TOMBSTONE_VALUES="$(jq -c --arg instance "$RECORDED_INSTANCE_ID" '. + {":instance":{S:$instance}}' <<<"$TOMBSTONE_VALUES")"
  else
    TOMBSTONE_CONDITION+=' AND attribute_not_exists(#instance)'
  fi
  PURGED_ITEM="$(jq -cn \
    --arg userSub "$USER_SUB" \
    --arg updatedAt "$PURGED_AT" \
    --arg expiresAt "$TOMBSTONE_EXPIRES_AT" \
    '{userSub:{S:$userSub},status:{S:"purged"},updatedAt:{S:$updatedAt},expiresAt:{N:$expiresAt}}')"
  TOMBSTONE_ARGUMENTS=(dynamodb put-item \
    --table-name "$TABLE_NAME" \
    --item "$PURGED_ITEM" \
    --condition-expression "$TOMBSTONE_CONDITION" \
    --expression-attribute-names '{"#status":"status","#updatedAt":"updatedAt","#stack":"runtimeStackName","#instance":"instanceId","#purge":"purgeLock","#purgeExpires":"purgeLockExpiresAt"}')
  if [[ "$(jq 'length' <<<"$TOMBSTONE_VALUES")" -gt 0 ]]; then
    TOMBSTONE_ARGUMENTS+=(--expression-attribute-values "$TOMBSTONE_VALUES")
  fi
  if ! TOMBSTONE_RESULT="$(aws_cli "${TOMBSTONE_ARGUMENTS[@]}" 2>&1)"; then
    printf '%s\n' "$TOMBSTONE_RESULT" >&2
    fail "The profile and runtime were deleted, but the locked registry record changed before its privacy tombstone could be written; inspect it before cleanup"
  fi
fi
if [[ "$REMOVED_RUNTIME" == "true" ]]; then
  say "The user and all assigned runtime stacks, including their persistent disks, were deleted; a short-lived access tombstone remains"
else
  say "The user was deleted; no managed runtime stack was present, and a short-lived access tombstone remains"
fi
