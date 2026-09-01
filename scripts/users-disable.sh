#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"
# shellcheck source=lib/stacks.sh
source "$SCRIPT_DIR/lib/stacks.sh"

require_config
EMAIL="$(normalize_email "$(prompt_email "$(read_option --email "$@" || true)")")"
[[ "$EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || fail "Enter a valid email address"
USER_POOL_ID="$(stack_output "$(foundation_stack)" UserPoolId)"
TABLE_NAME="$(stack_output "$(foundation_stack)" UserRegistryTableName)"
COGNITO_USER="$(find_cognito_user_by_email "$USER_POOL_ID" "$EMAIL")"
IFS=$'\t' read -r COGNITO_USERNAME USER_SUB <<<"$COGNITO_USER"
is_user_subject "$USER_SUB" || fail "Cognito returned an invalid federated subject"
EXPECTED_RUNTIME_STACK="$(runtime_stack_name_for_subject "$USER_SUB")"
KEY="$(jq -cn --arg userSub "$USER_SUB" '{userSub:{S:$userSub}}')"

REVOCATION_FAILED=false
QUIESCE_FAILED=false
REGISTRY_FAILED=false
CUTOFF_FAILED=false
ACTION=none
SECURED_INSTANCE_IDS=""
PRE_INSTANCE_ID=""
EARLY_STACK_INSTANCE_ID=""

secure_instance() {
  local instance_id="$1"
  [[ -n "$instance_id" ]] || return 0
  if ! is_instance_id "$instance_id"; then
    CUTOFF_FAILED=true
    return 0
  fi
  case ":$SECURED_INSTANCE_IDS:" in
    *":$instance_id:"*) return 0 ;;
  esac
  if cut_off_runtime_instance "$instance_id"; then
    SECURED_INSTANCE_IDS="${SECURED_INSTANCE_IDS:+$SECURED_INSTANCE_IDS:}$instance_id"
    ACTION=stopped
  else
    CUTOFF_FAILED=true
  fi
}

say "Disabling company sign-in before changing the assigned runtime"
if ! aws_cli cognito-idp admin-disable-user --user-pool-id "$USER_POOL_ID" --username "$COGNITO_USERNAME"; then
  printf 'WARNING: Cognito did not confirm that company sign-in was disabled; continuing with the runtime cutoff.\n' >&2
  REVOCATION_FAILED=true
fi
if ! aws_cli cognito-idp admin-user-global-sign-out --user-pool-id "$USER_POOL_ID" --username "$COGNITO_USERNAME"; then
  printf 'WARNING: Cognito did not confirm global token revocation; continuing with the runtime cutoff.\n' >&2
  REVOCATION_FAILED=true
fi

# Cut off the deterministic stack's instance before any registry or Step
# Functions call can fail. A first best-effort registry read covers an instance
# that was replaced but has not reached the stack output yet.
if PRE_RUNTIME="$(aws_cli dynamodb get-item \
  --table-name "$TABLE_NAME" \
  --key "$KEY" \
  --consistent-read \
  --output json 2>/dev/null)"; then
  if jq -e '(.Item // {}) | has("instanceId")' <<<"$PRE_RUNTIME" >/dev/null; then
    if PRE_INSTANCE_ID="$(jq -er '
      .Item.instanceId |
      if type == "object" and (.S | type == "string") then .S
      else error("invalid instanceId") end
    ' <<<"$PRE_RUNTIME")"; then
      secure_instance "$PRE_INSTANCE_ID"
    else
      CUTOFF_FAILED=true
    fi
  fi
fi
if stack_exists "$EXPECTED_RUNTIME_STACK"; then
  if EARLY_STACK_INSTANCE_ID="$(stack_output_optional "$EXPECTED_RUNTIME_STACK" InstanceId)"; then
    secure_instance "$EARLY_STACK_INSTANCE_ID"
  else
    CUTOFF_FAILED=true
  fi
else
  stack_status=$?
  [[ "$stack_status" -eq 1 ]] || CUTOFF_FAILED=true
fi

if ! stop_provisioning_executions "$USER_SUB"; then
  printf 'WARNING: Matching provisioning jobs could not all be stopped.\n' >&2
  QUIESCE_FAILED=true
fi

STATUS=""
INSTANCE_ID=""
STATE_LOCKED=false
REGISTRY_ITEM_PRESENT=false
STATUS_PRESENT=false
INSTANCE_ID_PRESENT=false
OBSERVED_STACK_PRESENT=false
OBSERVED_STARTED_AT_PRESENT=false
PURGE_LOCK_PRESENT=false
PURGE_LOCK_EXPIRES_AT_PRESENT=false

for ATTEMPT in 1 2 3; do
  if ! RUNTIME="$(aws_cli dynamodb get-item \
    --table-name "$TABLE_NAME" \
    --key "$KEY" \
    --consistent-read \
    --output json)"; then
    REGISTRY_FAILED=true
    break
  fi
  if [[ "$(jq '(.Item // {}) | length' <<<"$RUNTIME")" == "0" ]]; then
    # The registry is authoritative for browser access, but a stack can still
    # exist if setup was interrupted between CloudFormation and DynamoDB. Add
    # a disabled marker before returning so an already-issued Auth.js session
    # cannot start a new runtime after Cognito sign-out.
    STATUS=""
    INSTANCE_ID=""
    REGISTRY_ITEM_PRESENT=false
    DISABLED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    DISABLED_ITEM="$(jq -cn \
      --arg userSub "$USER_SUB" \
      --arg email "$EMAIL" \
      --arg stack "$EXPECTED_RUNTIME_STACK" \
      --arg updatedAt "$DISABLED_AT" '
        {userSub:{S:$userSub},email:{S:$email},runtimeStackName:{S:$stack},status:{S:"disabled"},updatedAt:{S:$updatedAt}}
      ')"
    if is_instance_id "$EARLY_STACK_INSTANCE_ID"; then
      DISABLED_ITEM="$(jq -c --arg instance "$EARLY_STACK_INSTANCE_ID" \
        '. + {instanceId:{S:$instance}}' <<<"$DISABLED_ITEM")"
    elif is_instance_id "$PRE_INSTANCE_ID"; then
      DISABLED_ITEM="$(jq -c --arg instance "$PRE_INSTANCE_ID" \
        '. + {instanceId:{S:$instance}}' <<<"$DISABLED_ITEM")"
    fi
    if PUT_RESULT="$(aws_cli dynamodb put-item \
      --table-name "$TABLE_NAME" \
      --item "$DISABLED_ITEM" \
      --condition-expression 'attribute_not_exists(userSub)' 2>&1)"; then
      STATE_LOCKED=true
      break
    fi
    if [[ "$PUT_RESULT" != *ConditionalCheckFailedException* ]]; then
      printf '%s\n' "$PUT_RESULT" >&2
      REGISTRY_FAILED=true
      break
    fi
    if [[ "$ATTEMPT" -lt 3 ]]; then
      sleep "$ATTEMPT"
      continue
    fi
    break
  fi
  REGISTRY_ITEM_PRESENT=true

  STATUS_PRESENT=false
  INSTANCE_ID_PRESENT=false
  OBSERVED_STACK_PRESENT=false
  OBSERVED_STARTED_AT_PRESENT=false
  PURGE_LOCK_PRESENT=false
  PURGE_LOCK_EXPIRES_AT_PRESENT=false
  STATUS=""
  INSTANCE_ID=""
  OBSERVED_STACK=""
  OBSERVED_STARTED_AT=""
  PURGE_LOCK=""
  PURGE_LOCK_EXPIRES_AT=""
  if jq -e '.Item | has("status")' <<<"$RUNTIME" >/dev/null; then
    STATUS_PRESENT=true
    STATUS="$(jq -er '.Item.status | if type == "object" and (.S | type == "string") then .S else error("invalid status") end' <<<"$RUNTIME")" || {
      REGISTRY_FAILED=true
      break
    }
  fi
  if jq -e '.Item | has("instanceId")' <<<"$RUNTIME" >/dev/null; then
    INSTANCE_ID_PRESENT=true
    INSTANCE_ID="$(jq -er '.Item.instanceId | if type == "object" and (.S | type == "string") then .S else error("invalid instanceId") end' <<<"$RUNTIME")" || {
      REGISTRY_FAILED=true
      break
    }
    if ! is_instance_id "$INSTANCE_ID"; then
      CUTOFF_FAILED=true
      REGISTRY_FAILED=true
      break
    fi
  fi
  if jq -e '.Item | has("runtimeStackName")' <<<"$RUNTIME" >/dev/null; then
    OBSERVED_STACK_PRESENT=true
    OBSERVED_STACK="$(jq -er '.Item.runtimeStackName | if type == "object" and (.S | type == "string") then .S else error("invalid runtimeStackName") end' <<<"$RUNTIME")" || {
      REGISTRY_FAILED=true
      break
    }
  fi
  if jq -e '.Item | has("provisioningStartedAt")' <<<"$RUNTIME" >/dev/null; then
    OBSERVED_STARTED_AT_PRESENT=true
    OBSERVED_STARTED_AT="$(jq -er '.Item.provisioningStartedAt | if type == "object" and (.S | type == "string") then .S else error("invalid provisioningStartedAt") end' <<<"$RUNTIME")" || {
      REGISTRY_FAILED=true
      break
    }
  fi
  if jq -e '.Item | has("purgeLock")' <<<"$RUNTIME" >/dev/null; then
    PURGE_LOCK_PRESENT=true
    PURGE_LOCK="$(jq -er '.Item.purgeLock | if type == "object" and (.S | type == "string" and length > 0) then .S else error("invalid purgeLock") end' <<<"$RUNTIME")" || {
      REGISTRY_FAILED=true
      break
    }
  fi
  if jq -e '.Item | has("purgeLockExpiresAt")' <<<"$RUNTIME" >/dev/null; then
    PURGE_LOCK_EXPIRES_AT_PRESENT=true
    PURGE_LOCK_EXPIRES_AT="$(jq -er '.Item.purgeLockExpiresAt | if type == "object" and (.N | type == "string" and test("^[1-9][0-9]*$")) then .N else error("invalid purgeLockExpiresAt") end' <<<"$RUNTIME")" || {
      REGISTRY_FAILED=true
      break
    }
  fi
  if [[ "$PURGE_LOCK_PRESENT" != "$PURGE_LOCK_EXPIRES_AT_PRESENT" ]]; then
    REGISTRY_FAILED=true
    break
  fi
  NOW_EPOCH="$(date +%s)"
  [[ "$NOW_EPOCH" =~ ^[0-9]+$ ]] || {
    REGISTRY_FAILED=true
    break
  }
  if [[ "$PURGE_LOCK_PRESENT" == "true" && "$PURGE_LOCK_EXPIRES_AT" -ge "$NOW_EPOCH" ]]; then
    printf 'WARNING: A permanent purge is already in progress for this user.\n' >&2
    REGISTRY_FAILED=true
    break
  fi
  secure_instance "$INSTANCE_ID"

  UPDATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  SET_ACTIONS='#status = :disabled, updatedAt = :updatedAt'
  REMOVE_ACTIONS='#enable, #enableExpires'
  UPDATE_CONDITION='attribute_exists(userSub)'
  UPDATE_NAMES='{"#status":"status","#instance":"instanceId","#stack":"runtimeStackName","#startedAt":"provisioningStartedAt","#purge":"purgeLock","#purgeExpires":"purgeLockExpiresAt","#enable":"enableToken","#enableExpires":"enableTokenExpiresAt"}'
  UPDATE_VALUES="$(jq -cn --arg updatedAt "$UPDATED_AT" '{":disabled":{S:"disabled"},":updatedAt":{S:$updatedAt}}')"
  if [[ "$STATUS_PRESENT" == "true" ]]; then
    UPDATE_CONDITION+=' AND #status = :observed'
    UPDATE_VALUES="$(jq -c --arg observed "$STATUS" '. + {":observed":{S:$observed}}' <<<"$UPDATE_VALUES")"
  else
    UPDATE_CONDITION+=' AND attribute_not_exists(#status)'
  fi
  if [[ "$INSTANCE_ID_PRESENT" == "true" ]]; then
    UPDATE_CONDITION+=' AND #instance = :observedInstance'
    UPDATE_VALUES="$(jq -c --arg observedInstance "$INSTANCE_ID" '. + {":observedInstance":{S:$observedInstance}}' <<<"$UPDATE_VALUES")"
  else
    UPDATE_CONDITION+=' AND attribute_not_exists(#instance)'
  fi
  if [[ "$OBSERVED_STACK_PRESENT" == "true" ]]; then
    UPDATE_CONDITION+=' AND #stack = :observedStack'
    UPDATE_VALUES="$(jq -c --arg observedStack "$OBSERVED_STACK" '. + {":observedStack":{S:$observedStack}}' <<<"$UPDATE_VALUES")"
  else
    UPDATE_CONDITION+=' AND attribute_not_exists(#stack)'
  fi
  if [[ "$OBSERVED_STARTED_AT_PRESENT" == "true" ]]; then
    UPDATE_CONDITION+=' AND #startedAt = :observedStartedAt'
    UPDATE_VALUES="$(jq -c --arg observedStartedAt "$OBSERVED_STARTED_AT" '. + {":observedStartedAt":{S:$observedStartedAt}}' <<<"$UPDATE_VALUES")"
  else
    UPDATE_CONDITION+=' AND attribute_not_exists(#startedAt)'
  fi
  if [[ "$PURGE_LOCK_PRESENT" == "true" ]]; then
    UPDATE_CONDITION+=' AND #purge = :observedPurge AND #purgeExpires = :observedPurgeExpires'
    UPDATE_VALUES="$(jq -c \
      --arg observedPurge "$PURGE_LOCK" \
      --arg observedPurgeExpires "$PURGE_LOCK_EXPIRES_AT" \
      '. + {":observedPurge":{S:$observedPurge},":observedPurgeExpires":{N:$observedPurgeExpires}}' \
      <<<"$UPDATE_VALUES")"
    REMOVE_ACTIONS+=', #purge, #purgeExpires'
  else
    UPDATE_CONDITION+=' AND attribute_not_exists(#purge) AND attribute_not_exists(#purgeExpires)'
  fi
  if [[ "$STATUS" != "provisioning" && "$STATUS" != "failed" ]] && \
    is_instance_id "$EARLY_STACK_INSTANCE_ID"; then
    SET_ACTIONS+=', #instance = :securedInstance'
    UPDATE_VALUES="$(jq -c --arg securedInstance "$EARLY_STACK_INSTANCE_ID" \
      '. + {":securedInstance":{S:$securedInstance}}' <<<"$UPDATE_VALUES")"
  fi
  if [[ "$STATUS" == "provisioning" || "$STATUS" == "failed" ]]; then
    # An unfinished stack is removed below. Do not leave its stale instance
    # pointer on the disabled marker that users-enable.sh later consumes.
    REMOVE_ACTIONS="${REMOVE_ACTIONS:+$REMOVE_ACTIONS, }#instance"
  fi
  UPDATE_EXPRESSION="SET $SET_ACTIONS"
  if [[ -n "$REMOVE_ACTIONS" ]]; then
    UPDATE_EXPRESSION+=" REMOVE $REMOVE_ACTIONS"
  fi
  if UPDATE_RESULT="$(aws_cli dynamodb update-item \
    --table-name "$TABLE_NAME" \
    --key "$KEY" \
    --update-expression "$UPDATE_EXPRESSION" \
    --condition-expression "$UPDATE_CONDITION" \
    --expression-attribute-names "$UPDATE_NAMES" \
    --expression-attribute-values "$UPDATE_VALUES" 2>&1)"; then
    STATE_LOCKED=true
    break
  fi

  if [[ "$UPDATE_RESULT" != *ConditionalCheckFailedException* ]]; then
    printf '%s\n' "$UPDATE_RESULT" >&2
    REGISTRY_FAILED=true
    break
  fi
  if [[ "$ATTEMPT" -lt 3 ]]; then
    sleep "$ATTEMPT"
  fi
done

if [[ "$STATE_LOCKED" != "true" ]]; then
  REGISTRY_FAILED=true
fi

STACK_PRESENT=false
STACK_INSTANCE_ID=""
if stack_exists "$EXPECTED_RUNTIME_STACK"; then
  STACK_PRESENT=true
  if STACK_INSTANCE_ID="$(stack_output_optional "$EXPECTED_RUNTIME_STACK" InstanceId)"; then
    secure_instance "$STACK_INSTANCE_ID"
  else
    CUTOFF_FAILED=true
  fi
else
  stack_status=$?
  [[ "$stack_status" -eq 1 ]] || CUTOFF_FAILED=true
fi

SHOULD_DELETE=false
if [[ "$STACK_PRESENT" == "true" && "$REGISTRY_FAILED" == "false" ]]; then
  case "$STATUS" in
    provisioning | failed) SHOULD_DELETE=true ;;
    active | disabled) ;;
    *)
      if ! is_instance_id "$INSTANCE_ID" && ! is_instance_id "$STACK_INSTANCE_ID"; then
        SHOULD_DELETE=true
      fi
      ;;
  esac
fi

if [[ "$SHOULD_DELETE" == "true" ]]; then
  delete_stack "$EXPECTED_RUNTIME_STACK"
  ACTION=deleted
fi

if [[ "$REVOCATION_FAILED" == "true" || "$QUIESCE_FAILED" == "true" || "$REGISTRY_FAILED" == "true" || "$CUTOFF_FAILED" == "true" ]]; then
  fail "The runtime cutoff was attempted, but sign-out, provisioning shutdown, or registry locking did not fully complete; run this command again"
fi

case "$ACTION" in
  deleted)
    say "The user is disabled and the unfinished runtime was removed"
    ;;
  stopped)
    say "The user is disabled and runtime access is stopped; its disk is preserved"
    ;;
  *)
    if [[ "$REGISTRY_ITEM_PRESENT" == "false" && "$STACK_PRESENT" == "false" ]]; then
      say "The user is disabled; no assigned runtime exists"
    else
      say "The user is disabled; no running instance was found, and any managed disk is preserved"
    fi
    ;;
esac
