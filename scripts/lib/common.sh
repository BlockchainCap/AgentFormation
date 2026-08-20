#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONFIG_FILE="${AGENTFORMATION_CONFIG:-$ROOT_DIR/agentformation.local.json}"
STATE_DIR="$ROOT_DIR/.agentformation"

say() { printf '==> %s\n' "$*"; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

require_config() {
  [[ -f "$CONFIG_FILE" ]] || fail "Copy agentformation.example.json to agentformation.local.json and review it first"
  jq -e . "$CONFIG_FILE" >/dev/null || fail "$CONFIG_FILE is not valid JSON"
}

config() {
  jq -er "$1" "$CONFIG_FILE"
}

deployment_name() { config '.deploymentName'; }
region() { printf '%s\n' "${AWS_REGION:-$(config '.region')}"; }
profile() { printf '%s\n' "${AWS_PROFILE:-${AGENTFORMATION_AWS_PROFILE:-default}}"; }

aws_cli() {
  aws --profile "$(profile)" --region "$(region)" "$@"
}

network_stack() { printf '%s-network\n' "$(deployment_name)"; }
foundation_stack() { printf '%s-foundation\n' "$(deployment_name)"; }
image_stack() { printf '%s-image\n' "$(deployment_name)"; }
web_stack() { printf '%s-web\n' "$(deployment_name)"; }
ami_parameter_path() { printf '/agentformation/%s/runtime-ami\n' "$(deployment_name)"; }

stack_output() {
  local stack="$1"
  local key="$2"
  aws_cli cloudformation describe-stacks \
    --stack-name "$stack" \
    --query "Stacks[0].Outputs[?OutputKey=='$key'].OutputValue | [0]" \
    --output text
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
