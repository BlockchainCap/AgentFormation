#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

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
RUNTIME="$(aws_cli dynamodb get-item \
  --table-name "$TABLE_NAME" \
  --key "$KEY" \
  --consistent-read \
  --output json)"
REGISTRY_ITEM_PRESENT=true
if [[ "$(jq '(.Item // {}) | length' <<<"$RUNTIME")" == "0" ]]; then
  REGISTRY_ITEM_PRESENT=false
fi
INSTANCE_ID_PRESENT=false
INSTANCE_ID=""
if [[ "$REGISTRY_ITEM_PRESENT" == "true" ]] && \
  jq -e '.Item | has("instanceId")' <<<"$RUNTIME" >/dev/null; then
  INSTANCE_ID_PRESENT=true
  INSTANCE_ID="$(jq -er '
    .Item.instanceId |
    if type == "object" and (.S | type == "string") then .S
    else error("invalid instanceId") end
  ' <<<"$RUNTIME")" || fail "The runtime registry contains an invalid instance ID"
  is_instance_id "$INSTANCE_ID" || fail "The runtime registry contains an invalid instance ID"
fi
STATUS="$(jq -r '.Item.status.S // ""' <<<"$RUNTIME")"

if [[ "$REGISTRY_ITEM_PRESENT" == "false" ]]; then
  UPDATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  ENABLE_ITEM="$(jq -cn \
    --arg userSub "$USER_SUB" \
    --arg email "$EMAIL" \
    --arg stack "$EXPECTED_RUNTIME_STACK" \
    --arg updatedAt "$UPDATED_AT" '
      {userSub:{S:$userSub},email:{S:$email},runtimeStackName:{S:$stack},status:{S:"failed"},updatedAt:{S:$updatedAt}}
    ')"
  if ! aws_cli dynamodb put-item \
    --table-name "$TABLE_NAME" \
    --item "$ENABLE_ITEM" \
    --condition-expression 'attribute_not_exists(userSub)' >/dev/null; then
    fail "The runtime changed while it was being enabled; sign-in remains disabled"
  fi
  REGISTRY_ITEM_PRESENT=true
  STATUS=failed
fi

ENABLE_LEASE_SECONDS=300
ENABLE_LEASE_NOW="$(date +%s)"
[[ "$ENABLE_LEASE_NOW" =~ ^[0-9]+$ ]] || fail "The local clock did not return a valid timestamp"
ENABLE_LEASE_EXPIRES_AT="$((ENABLE_LEASE_NOW + ENABLE_LEASE_SECONDS))"
ENABLE_TOKEN="${ENABLE_LEASE_NOW}-$$-${RANDOM}-${RANDOM}-${RANDOM}-${RANDOM}"

guard_enable_status() {
  local expected_status="$1"
  local phase="$2"
  local updated_at
  updated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if [[ "$phase" == "claim" ]]; then
    aws_cli dynamodb update-item \
      --table-name "$TABLE_NAME" \
      --key "$KEY" \
      --update-expression 'SET updatedAt = :updatedAt, #enable = :enable, #enableExpires = :enableExpires' \
      --condition-expression '#status = :expected AND attribute_not_exists(#purge) AND attribute_not_exists(#purgeExpires) AND ((attribute_not_exists(#enable) AND attribute_not_exists(#enableExpires)) OR (attribute_exists(#enable) AND attribute_exists(#enableExpires) AND #enableExpires < :now))' \
      --expression-attribute-names '{"#status":"status","#purge":"purgeLock","#purgeExpires":"purgeLockExpiresAt","#enable":"enableToken","#enableExpires":"enableTokenExpiresAt"}' \
      --expression-attribute-values "$(jq -cn \
        --arg expected "$expected_status" \
        --arg updatedAt "$updated_at" \
        --arg enable "$ENABLE_TOKEN" \
        --arg enableExpires "$ENABLE_LEASE_EXPIRES_AT" \
        --arg now "$ENABLE_LEASE_NOW" \
        '{":expected":{S:$expected},":updatedAt":{S:$updatedAt},":enable":{S:$enable},":enableExpires":{N:$enableExpires},":now":{N:$now}}')" >/dev/null
  else
    [[ "$phase" == "complete" ]] || fail "Internal enable phase is invalid"
    aws_cli dynamodb update-item \
      --table-name "$TABLE_NAME" \
      --key "$KEY" \
      --update-expression 'SET updatedAt = :updatedAt REMOVE #enable, #enableExpires' \
      --condition-expression '#status = :expected AND attribute_not_exists(#purge) AND attribute_not_exists(#purgeExpires) AND #enable = :enable AND #enableExpires = :enableExpires' \
      --expression-attribute-names '{"#status":"status","#purge":"purgeLock","#purgeExpires":"purgeLockExpiresAt","#enable":"enableToken","#enableExpires":"enableTokenExpiresAt"}' \
      --expression-attribute-values "$(jq -cn \
        --arg expected "$expected_status" \
        --arg updatedAt "$updated_at" \
        --arg enable "$ENABLE_TOKEN" \
        --arg enableExpires "$ENABLE_LEASE_EXPIRES_AT" \
        '{":expected":{S:$expected},":updatedAt":{S:$updatedAt},":enable":{S:$enable},":enableExpires":{N:$enableExpires}}')" >/dev/null
  fi
}

guard_disabled_without_instance() {
  local phase="$1"
  local updated_at
  updated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if [[ "$phase" == "claim" ]]; then
    aws_cli dynamodb update-item \
      --table-name "$TABLE_NAME" \
      --key "$KEY" \
      --update-expression 'SET updatedAt = :updatedAt, #enable = :enable, #enableExpires = :enableExpires' \
      --condition-expression '#status = :disabled AND attribute_not_exists(instanceId) AND attribute_not_exists(#purge) AND attribute_not_exists(#purgeExpires) AND ((attribute_not_exists(#enable) AND attribute_not_exists(#enableExpires)) OR (attribute_exists(#enable) AND attribute_exists(#enableExpires) AND #enableExpires < :now))' \
      --expression-attribute-names '{"#status":"status","#purge":"purgeLock","#purgeExpires":"purgeLockExpiresAt","#enable":"enableToken","#enableExpires":"enableTokenExpiresAt"}' \
      --expression-attribute-values "$(jq -cn \
        --arg updatedAt "$updated_at" \
        --arg enable "$ENABLE_TOKEN" \
        --arg enableExpires "$ENABLE_LEASE_EXPIRES_AT" \
        --arg now "$ENABLE_LEASE_NOW" \
        '{":disabled":{S:"disabled"},":updatedAt":{S:$updatedAt},":enable":{S:$enable},":enableExpires":{N:$enableExpires},":now":{N:$now}}')" >/dev/null
  else
    [[ "$phase" == "complete" ]] || fail "Internal enable phase is invalid"
    aws_cli dynamodb update-item \
      --table-name "$TABLE_NAME" \
      --key "$KEY" \
      --update-expression 'SET #status = :failed, updatedAt = :updatedAt REMOVE #enable, #enableExpires' \
      --condition-expression '#status = :disabled AND attribute_not_exists(instanceId) AND attribute_not_exists(#purge) AND attribute_not_exists(#purgeExpires) AND #enable = :enable AND #enableExpires = :enableExpires' \
      --expression-attribute-names '{"#status":"status","#purge":"purgeLock","#purgeExpires":"purgeLockExpiresAt","#enable":"enableToken","#enableExpires":"enableTokenExpiresAt"}' \
      --expression-attribute-values "$(jq -cn \
        --arg updatedAt "$updated_at" \
        --arg enable "$ENABLE_TOKEN" \
        --arg enableExpires "$ENABLE_LEASE_EXPIRES_AT" \
        '{":failed":{S:"failed"},":disabled":{S:"disabled"},":updatedAt":{S:$updatedAt},":enable":{S:$enable},":enableExpires":{N:$enableExpires}}')" >/dev/null
  fi
}

guard_disabled_with_instance() {
  local phase="$1"
  local updated_at
  updated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if [[ "$phase" == "claim" ]]; then
    aws_cli dynamodb update-item \
      --table-name "$TABLE_NAME" \
      --key "$KEY" \
      --update-expression 'SET updatedAt = :updatedAt, #enable = :enable, #enableExpires = :enableExpires' \
      --condition-expression '#status = :disabled AND #instance = :observedInstance AND attribute_not_exists(#purge) AND attribute_not_exists(#purgeExpires) AND ((attribute_not_exists(#enable) AND attribute_not_exists(#enableExpires)) OR (attribute_exists(#enable) AND attribute_exists(#enableExpires) AND #enableExpires < :now))' \
      --expression-attribute-names '{"#status":"status","#instance":"instanceId","#purge":"purgeLock","#purgeExpires":"purgeLockExpiresAt","#enable":"enableToken","#enableExpires":"enableTokenExpiresAt"}' \
      --expression-attribute-values "$(jq -cn \
        --arg updatedAt "$updated_at" \
        --arg observedInstance "$INSTANCE_ID" \
        --arg enable "$ENABLE_TOKEN" \
        --arg enableExpires "$ENABLE_LEASE_EXPIRES_AT" \
        --arg now "$ENABLE_LEASE_NOW" \
        '{":disabled":{S:"disabled"},":updatedAt":{S:$updatedAt},":observedInstance":{S:$observedInstance},":enable":{S:$enable},":enableExpires":{N:$enableExpires},":now":{N:$now}}')" >/dev/null
  else
    [[ "$phase" == "complete" ]] || fail "Internal enable phase is invalid"
    aws_cli dynamodb update-item \
      --table-name "$TABLE_NAME" \
      --key "$KEY" \
      --update-expression 'SET #status = :active, updatedAt = :updatedAt REMOVE #enable, #enableExpires' \
      --condition-expression '#status = :disabled AND #instance = :observedInstance AND attribute_not_exists(#purge) AND attribute_not_exists(#purgeExpires) AND #enable = :enable AND #enableExpires = :enableExpires' \
      --expression-attribute-names '{"#status":"status","#instance":"instanceId","#purge":"purgeLock","#purgeExpires":"purgeLockExpiresAt","#enable":"enableToken","#enableExpires":"enableTokenExpiresAt"}' \
      --expression-attribute-values "$(jq -cn \
        --arg updatedAt "$updated_at" \
        --arg observedInstance "$INSTANCE_ID" \
        --arg enable "$ENABLE_TOKEN" \
        --arg enableExpires "$ENABLE_LEASE_EXPIRES_AT" \
        '{":active":{S:"active"},":disabled":{S:"disabled"},":updatedAt":{S:$updatedAt},":observedInstance":{S:$observedInstance},":enable":{S:$enable},":enableExpires":{N:$enableExpires}}')" >/dev/null
  fi
}

disable_cognito_after_failed_enable() {
  if ! aws_cli cognito-idp admin-disable-user \
    --user-pool-id "$USER_POOL_ID" \
    --username "$COGNITO_USERNAME"; then
    printf 'WARNING: Cognito sign-in could not be disabled again; check the user before retrying.\n' >&2
  fi
}

enable_existing_status() {
  local expected_status="$1"
  local success_message="$2"
  guard_enable_status "$expected_status" claim || \
    fail "A permanent purge, another enable, or another runtime change is in progress; no change was made"
  if ! aws_cli cognito-idp admin-enable-user --user-pool-id "$USER_POOL_ID" --username "$COGNITO_USERNAME"; then
    fail "Cognito did not confirm that company sign-in was enabled"
  fi
  if ! guard_enable_status "$expected_status" complete; then
    disable_cognito_after_failed_enable
    fail "The runtime changed while it was being enabled; check Cognito sign-in before retrying"
  fi
  say "$success_message"
}

if [[ "$STATUS" == "failed" ]]; then
  enable_existing_status "failed" "The user is enabled and can create or retry an environment"
  exit
fi

if [[ "$STATUS" == "active" ]]; then
  enable_existing_status "active" "The user is enabled and the runtime is already active"
  exit
fi

[[ "$STATUS" == "disabled" ]] || fail "That runtime is not ready to be enabled"

if [[ "$INSTANCE_ID_PRESENT" == "false" ]]; then
  guard_disabled_without_instance claim || \
    fail "A permanent purge, another enable, or another runtime change is in progress; no change was made"
  say "Restoring sign-in so the user can create a runtime"
  aws_cli cognito-idp admin-enable-user --user-pool-id "$USER_POOL_ID" --username "$COGNITO_USERNAME"
  if ! guard_disabled_without_instance complete; then
    disable_cognito_after_failed_enable
    fail "The runtime changed while it was being enabled; check Cognito sign-in before retrying"
  fi
  say "The user is enabled and can create or retry an environment"
  exit
fi

guard_disabled_with_instance claim || \
  fail "A permanent purge, another enable, or another runtime change is in progress; no change was made"
say "Starting the preserved runtime before restoring sign-in"
aws_cli ec2 start-instances --instance-ids "$INSTANCE_ID" >/dev/null
if ! aws_cli cognito-idp admin-enable-user --user-pool-id "$USER_POOL_ID" --username "$COGNITO_USERNAME"; then
  cut_off_runtime_instance "$INSTANCE_ID" || \
    printf 'WARNING: The preserved runtime could not be stopped after the enable attempt failed.\n' >&2
  fail "Cognito did not confirm that company sign-in was enabled"
fi
if ! guard_disabled_with_instance complete; then
  disable_cognito_after_failed_enable
  cut_off_runtime_instance "$INSTANCE_ID" || \
    printf 'WARNING: The preserved runtime could not be stopped after the enable attempt failed.\n' >&2
  fail "The runtime changed while it was being enabled; check Cognito sign-in before retrying"
fi
say "The user is enabled and the preserved runtime is starting"
