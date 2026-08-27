#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONFIG_FILE="${AGENTFORMATION_CONFIG:-$ROOT_DIR/agentformation.local.json}"
STATE_DIR="$ROOT_DIR/.agentformation"

say() { printf '==> %s\n' "$*"; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

require_https_origin() {
  local label="$1"
  local value="$2"
  local authority host port
  if [[ ! "$value" =~ ^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:([0-9]{1,5}))?$ ]]; then
    fail "$label must be an HTTPS origin without a path or trailing slash"
  fi
  port="${BASH_REMATCH[3]:-}"
  authority="${value#https://}"
  host="${authority%%:*}"
  if [[ "$host" == *..* || "$host" == *.-* || "$host" == *-.* ]]; then
    fail "$label must be an HTTPS origin without a path or trailing slash"
  fi
  if [[ -n "$port" ]] && (( 10#$port < 1 || 10#$port > 65535 )); then
    fail "$label must use a valid HTTPS port"
  fi
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

require_config() {
  local deployment
  [[ -f "$CONFIG_FILE" ]] || fail "Copy agentformation.example.json to agentformation.local.json and review it first"
  jq -e . "$CONFIG_FILE" >/dev/null || fail "$CONFIG_FILE is not valid JSON"
  deployment="$(jq -er '.deploymentName | select(type == "string")' "$CONFIG_FILE")" || \
    fail "$CONFIG_FILE must contain a deploymentName string"
  [[ "$deployment" =~ ^[a-z][a-z0-9-]{2,31}$ && "$deployment" != *-runtime-* ]] || \
    fail "deploymentName must start with a lowercase letter, contain only lowercase letters, numbers, and hyphens, be 3-32 characters, and not contain -runtime-"
}

config() {
  jq -er "$1" "$CONFIG_FILE"
}

deployment_name() { config '.deploymentName'; }
region() {
  if [[ -n "${AWS_REGION:-}" ]]; then
    printf '%s\n' "$AWS_REGION"
  else
    config '.region'
  fi
}
profile() { printf '%s\n' "${AWS_PROFILE:-${AGENTFORMATION_AWS_PROFILE:-default}}"; }

aws_cli() {
  aws --profile "$(profile)" --region "$(region)" "$@"
}

network_stack() { printf '%s-network\n' "$(deployment_name)"; }
foundation_stack() { printf '%s-foundation\n' "$(deployment_name)"; }
image_stack() { printf '%s-image\n' "$(deployment_name)"; }
provisioning_stack() { printf '%s-provisioning\n' "$(deployment_name)"; }
web_stack() { printf '%s-web\n' "$(deployment_name)"; }
ami_parameter_path() { printf '/agentformation/%s/runtime-ami\n' "$(deployment_name)"; }

is_user_subject() {
  [[ "$1" =~ ^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$ ]]
}

is_instance_id() {
  [[ "$1" =~ ^i-([0-9a-f]{8}|[0-9a-f]{17})$ ]]
}

runtime_stack_name_for_subject() {
  local user_sub="$1"
  local subject_part_one subject_part_two subject_part_three _
  is_user_subject "$user_sub" || \
    fail "Cognito returned an invalid federated subject"
  IFS=- read -r subject_part_one subject_part_two subject_part_three _ <<<"$user_sub"
  printf '%s-runtime-%s%s%s\n' \
    "$(deployment_name)" \
    "$subject_part_one" \
    "$subject_part_two" \
    "$subject_part_three"
}

stack_exists() {
  local stack="$1"
  local result
  if result="$(aws_cli cloudformation describe-stacks --stack-name "$stack" --output json 2>&1)"; then
    return 0
  fi
  if [[ "$result" == *ValidationError* && "$result" == *"does not exist"* ]]; then
    return 1
  fi
  printf '%s\n' "$result" >&2
  return 2
}

stack_output() {
  local stack="$1"
  local key="$2"
  local value
  value="$(aws_cli cloudformation describe-stacks \
    --stack-name "$stack" \
    --query "Stacks[0].Outputs[?OutputKey=='$key'].OutputValue | [0]" \
    --output text)" || return 1
  if [[ -z "$value" || "$value" == "None" ]]; then
    printf 'ERROR: CloudFormation stack %s did not return the required %s output\n' "$stack" "$key" >&2
    return 1
  fi
  printf '%s\n' "$value"
}

stack_output_optional() {
  local stack="$1"
  local key="$2"
  local value
  value="$(aws_cli cloudformation describe-stacks \
    --stack-name "$stack" \
    --query "Stacks[0].Outputs[?OutputKey=='$key'].OutputValue | [0]" \
    --output text)" || return 1
  if [[ -n "$value" && "$value" != "None" ]]; then
    printf '%s\n' "$value"
  fi
}

hash_text() {
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$1" | sha256sum | awk '{print $1}'
  else
    printf '%s' "$1" | shasum -a 256 | awk '{print $1}'
  fi
}

normalize_email() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | xargs
}

find_cognito_user_by_email() {
  local user_pool_id="$1"
  local email="$2"
  local users
  users="$(aws_cli cognito-idp list-users \
    --user-pool-id "$user_pool_id" \
    --output json)"
  users="$(jq -c --arg email "$email" '
    [.Users[] | select(
      ([.Attributes[] | select(.Name == "email") | .Value][0] // "" | ascii_downcase) == $email
    )]
  ' <<<"$users")"
  [[ "$(jq 'length' <<<"$users")" == "1" ]] || \
    fail "Expected exactly one federated user for that email address"
  jq -er '.[0] | [.Username, (.Attributes[] | select(.Name == "sub").Value)] | @tsv' <<<"$users"
}

quiesce_provisioning_executions() {
  local user_sub="${1:-}"
  local state_machine_arn executions execution_arns execution_arn execution_input input_subject
  local matching_found quiet_passes=0 attempt=1 stack_status stop_result

  if stack_exists "$(provisioning_stack)"; then
    :
  else
    stack_status=$?
    [[ "$stack_status" -eq 1 ]] && return 0
    return "$stack_status"
  fi

  state_machine_arn="$(stack_output "$(provisioning_stack)" StateMachineArn)"
  [[ "$state_machine_arn" =~ ^arn:[A-Za-z0-9-]+:states:[A-Za-z0-9-]+:[0-9]{12}:stateMachine:[A-Za-z0-9+=,.@_-]+$ ]] || {
    printf 'ERROR: The provisioning stack returned an invalid state machine ARN\n' >&2
    return 1
  }

  # Stop requests are asynchronous. Require two consecutive empty reads so a
  # teardown cannot race one last state transition into a new runtime stack.
  while [[ "$attempt" -le 30 ]]; do
    executions="$(aws_cli stepfunctions list-executions \
      --state-machine-arn "$state_machine_arn" \
      --status-filter RUNNING \
      --output json)" || return 1
    execution_arns="$(jq -er '[.executions[]?.executionArn] | join("\n")' <<<"$executions")" || return 1
    matching_found=false

    while IFS= read -r execution_arn; do
      [[ -n "$execution_arn" ]] || continue
      if [[ -n "$user_sub" ]]; then
        execution_input="$(aws_cli stepfunctions describe-execution \
          --execution-arn "$execution_arn" \
          --query input \
          --output text)" || return 1
        if ! input_subject="$(jq -er '
          if type == "object" and (.subject | type == "string")
          then .subject
          else error("missing subject")
          end
        ' <<<"$execution_input" 2>/dev/null)"; then
          printf 'ERROR: A running provisioning execution has invalid input; refusing to continue teardown\n' >&2
          return 1
        fi
        if ! is_user_subject "$input_subject"; then
          printf 'ERROR: A running provisioning execution has an invalid federated subject; refusing to continue teardown\n' >&2
          return 1
        fi
        [[ "$input_subject" == "$user_sub" ]] || continue
      fi

      matching_found=true
      if ! stop_result="$(aws_cli stepfunctions stop-execution \
        --execution-arn "$execution_arn" \
        --error AdministratorDisabledUser \
        --cause 'The federated user or deployment was disabled by an administrator.' 2>&1)"; then
        if [[ "$stop_result" != *ExecutionDoesNotExist* && \
          ! ( "$stop_result" == *ValidationException* && "$stop_result" == *"not RUNNING"* ) ]]; then
          printf '%s\n' "$stop_result" >&2
          return 1
        fi
      fi
    done <<<"$execution_arns"

    if [[ "$matching_found" == "false" ]]; then
      quiet_passes=$((quiet_passes + 1))
      [[ "$quiet_passes" -ge 2 ]] && return 0
    else
      quiet_passes=0
    fi
    sleep 2
    attempt=$((attempt + 1))
  done

  printf 'ERROR: Provisioning executions did not stop within 60 seconds\n' >&2
  return 1
}

stop_provisioning_executions() {
  local user_sub="$1"
  is_user_subject "$user_sub" || {
    printf 'ERROR: Refusing to inspect provisioning executions for an invalid federated subject\n' >&2
    return 1
  }
  quiesce_provisioning_executions "$user_sub"
}

stop_all_provisioning_executions() {
  quiesce_provisioning_executions
}

terminate_runtime_sessions() {
  local instance_id="$1"
  local sessions session_id
  local termination_failed=false
  is_instance_id "$instance_id" || return 1
  if ! sessions="$(aws_cli ssm describe-sessions \
    --state Active \
    --filters "key=Target,value=$instance_id" \
    --query 'Sessions[].SessionId' \
    --output json)"; then
    return 1
  fi
  while IFS= read -r session_id; do
    [[ -n "$session_id" ]] || continue
    if ! aws_cli ssm terminate-session --session-id "$session_id" >/dev/null; then
      termination_failed=true
    fi
  done < <(jq -r '.[]' <<<"$sessions")
  [[ "$termination_failed" == "false" ]]
}

cut_off_runtime_instance() {
  local instance_id="$1"
  local state_result state stop_result
  is_instance_id "$instance_id" || return 1

  if ! state_result="$(aws_cli ec2 describe-instances \
    --instance-ids "$instance_id" \
    --query 'Reservations[0].Instances[0].State.Name' \
    --output text 2>&1)"; then
    if [[ "$state_result" == *InvalidInstanceID.NotFound* ]]; then
      return 0
    fi
    printf '%s\n' "$state_result" >&2
    return 1
  fi
  state="$state_result"

  case "$state" in
    None | stopping | stopped | shutting-down | terminated)
      return 0
      ;;
    pending | running)
      if ! terminate_runtime_sessions "$instance_id"; then
        printf 'WARNING: Some Session Manager connections could not be terminated; stopping the instance remains the final cutoff.\n' >&2
      fi
      if ! stop_result="$(aws_cli ec2 stop-instances --instance-ids "$instance_id" 2>&1)"; then
        if [[ "$stop_result" == *InvalidInstanceID.NotFound* || "$stop_result" == *IncorrectInstanceState* ]]; then
          return 0
        fi
        printf '%s\n' "$stop_result" >&2
        return 1
      fi
      ;;
    *)
      printf 'ERROR: EC2 returned an unexpected state for %s: %s\n' "$instance_id" "$state" >&2
      return 1
      ;;
  esac
}

read_option() {
  local option="$1"
  shift
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == "$option" && $# -ge 2 ]]; then
      printf '%s\n' "$2"
      return 0
    fi
    shift
  done
  return 1
}

prompt_email() {
  local supplied="${1:-}"
  if [[ -n "$supplied" ]]; then
    normalize_email "$supplied"
    return
  fi
  local entered
  read -r -p 'Email: ' entered
  normalize_email "$entered"
}

ensure_state_dir() {
  mkdir -p "$STATE_DIR"
  chmod 0700 "$STATE_DIR"
}
