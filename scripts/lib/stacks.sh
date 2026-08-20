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
    --capabilities CAPABILITY_IAM \
    --no-fail-on-empty-changeset \
    --tags AgentFormationDeployment="$(deployment_name)" \
    --parameter-overrides "$@")
  if [[ -n "$role_arn" ]]; then
    arguments+=(--role-arn "$role_arn")
  fi
  aws_cli "${arguments[@]}"
}

delete_stack() {
  local stack="$1"
  if ! aws_cli cloudformation describe-stacks --stack-name "$stack" >/dev/null 2>&1; then
    return
  fi
  say "Deleting $stack"
  aws_cli cloudformation delete-stack --stack-name "$stack"
  aws_cli cloudformation wait stack-delete-complete --stack-name "$stack"
}
