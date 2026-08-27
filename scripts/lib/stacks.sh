#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

deploy_stack() {
  local stack="$1"
  local template="$2"
  local role_arn
  local -a arguments
  shift 2
  say "Deploying $stack"
  role_arn="$(config '.cloudFormationRoleArn // empty')"
  arguments=(cloudformation deploy \
    --stack-name "$stack" \
    --template-file "$ROOT_DIR/$template" \
    --capabilities CAPABILITY_NAMED_IAM \
    --no-fail-on-empty-changeset \
    --tags AgentFormationDeployment="$(deployment_name)" \
    --parameter-overrides "$@")
  if [[ -n "$role_arn" ]]; then
    arguments+=(--role-arn "$role_arn")
  fi
  aws_cli "${arguments[@]}"
}

delete_stack_if_present() {
  local stack="$1"
  local stack_status
  if stack_exists "$stack"; then
    :
  else
    stack_status=$?
    [[ "$stack_status" -eq 1 ]] && return 1
    return "$stack_status"
  fi
  say "Deleting $stack"
  aws_cli cloudformation delete-stack --stack-name "$stack" || return 2
  aws_cli cloudformation wait stack-delete-complete --stack-name "$stack" || return 2
}

delete_stack() {
  local stack="$1"
  local delete_status=0
  delete_stack_if_present "$stack" || delete_status=$?
  case "$delete_status" in
    0 | 1) return 0 ;;
    *) return "$delete_status" ;;
  esac
}
