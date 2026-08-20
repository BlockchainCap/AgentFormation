#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"
# shellcheck source=lib/stacks.sh
source "$SCRIPT_DIR/lib/stacks.sh"

"$SCRIPT_DIR/doctor.sh"
ensure_state_dir

DEPLOYMENT="$(deployment_name)"
ACCOUNT_ID="$(aws_cli sts get-caller-identity --query Account --output text)"
DOMAIN_SUFFIX="$(hash_text "$ACCOUNT_ID:$DEPLOYMENT" | cut -c1-10)"
DOMAIN_PREFIX="$DEPLOYMENT-$DOMAIN_SUFFIX"

deploy_stack "$(network_stack)" templates/network.yaml \
  DeploymentName="$DEPLOYMENT" \
  NetworkMode="$(config '.networkMode')"

deploy_stack "$(foundation_stack)" templates/foundation.yaml \
  DeploymentName="$DEPLOYMENT" \
  CognitoDomainPrefix="$DOMAIN_PREFIX"

USER_POOL_ID="$(stack_output "$(foundation_stack)" UserPoolId)"
CLIENT_ID="$(stack_output "$(foundation_stack)" UserPoolClientId)"
CLIENT_SECRET_ARN="$(stack_output "$(foundation_stack)" CognitoClientSecretArn)"

say "Storing the generated Cognito client secret without printing it"
aws_cli cognito-idp describe-user-pool-client \
  --user-pool-id "$USER_POOL_ID" \
  --client-id "$CLIENT_ID" \
  --query 'UserPoolClient.ClientSecret' \
  --output text | \
  aws_cli secretsmanager put-secret-value \
    --secret-id "$CLIENT_SECRET_ARN" \
    --secret-string file:///dev/stdin >/dev/null

ARCHITECTURE="$(config '.runtime.architecture')"
CLAUDE_CODE_VERSION="$(config '.versions.claudeCode')"
CODEX_VERSION="$(config '.versions.codex')"
IMAGE_TEMPLATE_HASH="$(hash_text "$(<"$ROOT_DIR/templates/image.yaml")")"
IMAGE_COMPONENT_HASH="$(hash_text "$ARCHITECTURE:$CLAUDE_CODE_VERSION:$CODEX_VERSION:$IMAGE_TEMPLATE_HASH")"
IMAGE_COMPONENT_VERSION="1.0.$((16#${IMAGE_COMPONENT_HASH:0:7}))"
if [[ "$ARCHITECTURE" == "arm64" ]]; then
  BUILD_INSTANCE="c7g.large"
else
  BUILD_INSTANCE="c7i.large"
fi

deploy_stack "$(image_stack)" templates/image.yaml \
  DeploymentName="$DEPLOYMENT" \
  NetworkStackName="$(network_stack)" \
  Architecture="$ARCHITECTURE" \
  BuildInstanceType="$BUILD_INSTANCE" \
  ClaudeCodeVersion="$CLAUDE_CODE_VERSION" \
  CodexVersion="$CODEX_VERSION" \
  AmiParameterPath="$(ami_parameter_path)" \
  ComponentVersion="$IMAGE_COMPONENT_VERSION"

PIPELINE_ARN="$(stack_output "$(image_stack)" ImagePipelineArn)"
IMAGE_ARN=""
if [[ "${AGENTFORMATION_REBUILD_IMAGE:-0}" != "1" ]]; then
  IMAGE_ARN="$(aws_cli imagebuilder list-image-pipeline-images \
    --image-pipeline-arn "$PIPELINE_ARN" \
    --query "reverse(sort_by(imageSummaryList[?state.status==\`AVAILABLE\`],&dateCreated))[0].arn" \
    --output text)"
  [[ "$IMAGE_ARN" == "None" ]] && IMAGE_ARN=""
fi

if [[ -z "$IMAGE_ARN" ]]; then
  say "Starting the AMI build; this commonly takes 15–30 minutes"
  IMAGE_ARN="$(aws_cli imagebuilder start-image-pipeline-execution \
    --image-pipeline-arn "$PIPELINE_ARN" \
    --query imageBuildVersionArn \
    --output text)"

  while true; do
    IMAGE_STATUS="$(aws_cli imagebuilder get-image \
      --image-build-version-arn "$IMAGE_ARN" \
      --query 'image.state.status' \
      --output text)"
    say "Image Builder status: $IMAGE_STATUS"
    case "$IMAGE_STATUS" in
      AVAILABLE) break ;;
      FAILED|CANCELLED|DELETED)
        aws_cli imagebuilder get-image --image-build-version-arn "$IMAGE_ARN" --query 'image.state.reason' --output text >&2
        fail "AMI build did not complete"
        ;;
    esac
    sleep 30
  done
else
  say "Reusing the latest tested AMI from the current image pipeline"
fi

AMI_ID="$(aws_cli imagebuilder get-image \
    --image-build-version-arn "$IMAGE_ARN" \
    --query 'image.outputResources.amis[0].image' \
    --output text)"
[[ "$AMI_ID" =~ ^ami-[0-9a-f]+$ ]] || fail "Image Builder did not return an AMI ID"
aws_cli ssm put-parameter \
  --name "$(ami_parameter_path)" \
  --type String \
  --value "$AMI_ID" \
  --overwrite >/dev/null

REPOSITORY_URI="$(stack_output "$(foundation_stack)" WebRepositoryUri)"
IMAGE_TAG="$(date -u +%Y%m%d%H%M%S)"
REGISTRY_HOST="${REPOSITORY_URI%%/*}"
DOCKER_CONFIG_DIR="$STATE_DIR/docker"
DOCKER_AUTH_FILE="$DOCKER_CONFIG_DIR/config.json"
BUILDER_NAME="${DEPLOYMENT}-builder"
DOCKER_ENDPOINT="$(docker context inspect --format '{{.Endpoints.docker.Host}}')"
install -d -m 0700 "$DOCKER_CONFIG_DIR"
BUILDX_PLUGIN="$(docker info --format '{{range .ClientInfo.Plugins}}{{if eq .Name "buildx"}}{{.Path}}{{end}}{{end}}')"
if [[ -n "$BUILDX_PLUGIN" ]]; then
  install -d -m 0700 "$DOCKER_CONFIG_DIR/cli-plugins"
  ln -sfn "$BUILDX_PLUGIN" "$DOCKER_CONFIG_DIR/cli-plugins/docker-buildx"
fi
say "Building and pushing the App Runner image"
ECR_PASSWORD="$(aws_cli ecr get-login-password)"
ECR_AUTH="$(printf 'AWS:%s' "$ECR_PASSWORD" | base64 | tr -d '\n')"
printf '{"auths":{"%s":{"auth":"%s"}}}\n' "$REGISTRY_HOST" "$ECR_AUTH" >"$DOCKER_AUTH_FILE"
chmod 0600 "$DOCKER_AUTH_FILE"
unset ECR_PASSWORD ECR_AUTH
cleanup_docker_auth() {
  printf '{"auths":{}}\n' >"$DOCKER_AUTH_FILE"
  chmod 0600 "$DOCKER_AUTH_FILE"
}
trap cleanup_docker_auth EXIT

if ! DOCKER_HOST="$DOCKER_ENDPOINT" docker --config "$DOCKER_CONFIG_DIR" buildx inspect "$BUILDER_NAME" >/dev/null 2>&1; then
  DOCKER_HOST="$DOCKER_ENDPOINT" docker --config "$DOCKER_CONFIG_DIR" buildx rm "$BUILDER_NAME" >/dev/null 2>&1 || true
  DOCKER_HOST="$DOCKER_ENDPOINT" docker --config "$DOCKER_CONFIG_DIR" buildx create \
    --name "$BUILDER_NAME" \
    --driver docker-container >/dev/null
fi
DOCKER_HOST="$DOCKER_ENDPOINT" docker --config "$DOCKER_CONFIG_DIR" buildx inspect "$BUILDER_NAME" --bootstrap >/dev/null
DOCKER_HOST="$DOCKER_ENDPOINT" docker --config "$DOCKER_CONFIG_DIR" buildx build \
  --builder "$BUILDER_NAME" \
  --platform linux/amd64 \
  --progress plain \
  --provenance=true \
  --sbom=true \
  --push \
  --tag "$REPOSITORY_URI:${IMAGE_TAG}-attested" \
  "$ROOT_DIR/web"

# App Runner expects a conventional single-platform image tag. Publish the same
# cached layers in Docker v2 format while retaining the attested OCI tag above.
DOCKER_HOST="$DOCKER_ENDPOINT" docker --config "$DOCKER_CONFIG_DIR" buildx build \
  --builder "$BUILDER_NAME" \
  --platform linux/amd64 \
  --progress plain \
  --provenance=false \
  --sbom=false \
  --output "type=image,name=$REPOSITORY_URI:$IMAGE_TAG,push=true,oci-mediatypes=false" \
  "$ROOT_DIR/web"
cleanup_docker_auth
trap - EXIT

deploy_web_stack() {
  local public_url="$1"
  deploy_stack "$(web_stack)" templates/web.yaml \
    DeploymentName="$DEPLOYMENT" \
    ImageIdentifier="$REPOSITORY_URI:$IMAGE_TAG" \
    PublicUrl="$public_url" \
    UserPoolClientId="$CLIENT_ID" \
    CognitoIssuer="$(stack_output "$(foundation_stack)" CognitoIssuer)" \
    CognitoClientSecretArn="$CLIENT_SECRET_ARN" \
    AuthSecretArn="$(stack_output "$(foundation_stack)" AuthSecretArn)" \
    UserRegistryTableName="$(stack_output "$(foundation_stack)" UserRegistryTableName)" \
    UploadBucketName="$(stack_output "$(foundation_stack)" UploadBucketName)" \
    TerminalSessionDocumentName="$(stack_output "$(foundation_stack)" TerminalSessionDocumentName)"
}

INITIAL_SERVICE_URL="$(stack_output "$(web_stack)" ServiceUrl 2>/dev/null || true)"
if [[ ! "$INITIAL_SERVICE_URL" =~ ^https?:// ]]; then
  INITIAL_SERVICE_URL='http://localhost:3000'
fi
deploy_web_stack "$INITIAL_SERVICE_URL"

SERVICE_URL="$(stack_output "$(web_stack)" ServiceUrl)"
if [[ "$INITIAL_SERVICE_URL" != "$SERVICE_URL" ]]; then
  say "Applying the new App Runner public address to Auth.js"
  deploy_web_stack "$SERVICE_URL"
fi
say "Updating Cognito callback URLs for the App Runner service"
aws_cli cognito-idp update-user-pool-client \
  --user-pool-id "$USER_POOL_ID" \
  --client-id "$CLIENT_ID" \
  --supported-identity-providers COGNITO \
  --allowed-o-auth-flows code \
  --allowed-o-auth-scopes openid email profile \
  --allowed-o-auth-flows-user-pool-client \
  --callback-urls "$SERVICE_URL/api/auth/callback/cognito" http://localhost:3000/api/auth/callback/cognito \
  --logout-urls "$SERVICE_URL/" http://localhost:3000/ \
  --prevent-user-existence-errors ENABLED \
  --enable-token-revocation \
  --access-token-validity 60 \
  --id-token-validity 60 \
  --refresh-token-validity 1 \
  --token-validity-units AccessToken=minutes,IdToken=minutes,RefreshToken=days >/dev/null

say "Restricting browser uploads to the deployed web address"
UPLOAD_CORS_CONFIGURATION="$(jq -cn --arg serviceUrl "$SERVICE_URL" '{
  CORSRules: [{
    AllowedHeaders: ["content-type"],
    AllowedMethods: ["PUT"],
    AllowedOrigins: [$serviceUrl, "http://localhost:3000"],
    ExposeHeaders: ["ETag"],
    MaxAgeSeconds: 300
  }]
}')"
aws_cli s3api put-bucket-cors \
  --bucket "$(stack_output "$(foundation_stack)" UploadBucketName)" \
  --cors-configuration "$UPLOAD_CORS_CONFIGURATION"

while IFS= read -r EMAIL; do
  [[ -n "$EMAIL" ]] || continue
  "$SCRIPT_DIR/users-add.sh" --email "$EMAIL"
done < <(config '.users[].email')

cat >"$STATE_DIR/deployment.json" <<STATE
{"deploymentName":"$DEPLOYMENT","region":"$(region)","serviceUrl":"$SERVICE_URL","imageBuildVersionArn":"$IMAGE_ARN"}
STATE
chmod 0600 "$STATE_DIR/deployment.json"

say "AgentFormation deployment is ready: $SERVICE_URL"
