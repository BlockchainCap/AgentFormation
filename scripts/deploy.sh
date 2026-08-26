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
CALLER_ARN="$(aws_cli sts get-caller-identity --query Arn --output text)"
AWS_PARTITION="$(cut -d: -f2 <<<"$CALLER_ARN")"
if [[ "$AWS_PARTITION" == "aws-cn" ]]; then
  AWS_URL_SUFFIX="amazonaws.com.cn"
else
  AWS_URL_SUFFIX="amazonaws.com"
fi
DOMAIN_SUFFIX="$(hash_text "$ACCOUNT_ID:$DEPLOYMENT" | cut -c1-10)"
DOMAIN_PREFIX="$DEPLOYMENT-$DOMAIN_SUFFIX"
IDENTITY_CENTER_METADATA_URL="$(config '.identityCenter.metadataUrl // ""')"
IDENTITY_CENTER_METADATA_FILE="$(config '.identityCenter.metadataFile // ""')"
CONFIGURED_PUBLIC_URL="$(config '(.publicUrl // "") | rtrimstr("/")')"
if [[ -n "$IDENTITY_CENTER_METADATA_FILE" && "$IDENTITY_CENTER_METADATA_FILE" != /* ]]; then
  IDENTITY_CENTER_METADATA_FILE="$ROOT_DIR/$IDENTITY_CENTER_METADATA_FILE"
fi

CONFIGURE_CASE_INSENSITIVE_USERNAMES=true
if aws_cli cloudformation describe-stacks --stack-name "$(foundation_stack)" >/dev/null 2>&1; then
  EXISTING_USER_POOL_ID="$(stack_output "$(foundation_stack)" UserPoolId)"
  EXISTING_USERNAME_CASE_SENSITIVE="$(aws_cli cognito-idp describe-user-pool \
    --user-pool-id "$EXISTING_USER_POOL_ID" \
    --query 'UserPool.UsernameConfiguration.CaseSensitive' \
    --output text)"
  case "$EXISTING_USERNAME_CASE_SENSITIVE" in
    False | false)
      CONFIGURE_CASE_INSENSITIVE_USERNAMES=true
      ;;
    True | true | None | none | null | '')
      # Older pools can omit this immutable property; Cognito then keeps its
      # original case-sensitive default. Preserve it during an upgrade.
      CONFIGURE_CASE_INSENSITIVE_USERNAMES=false
      ;;
    *)
      fail "Could not determine the existing Cognito username case-sensitivity setting"
      ;;
  esac
fi

print_identity_center_setup() {
  local acs_url audience user_pool_id outputs cognito_domain_suffix
  outputs="$(aws_cli cloudformation describe-stacks \
    --stack-name "$(foundation_stack)" \
    --query 'Stacks[0].Outputs' \
    --output json)"
  acs_url="$(jq -r '[.[] | select(.OutputKey == "CognitoSamlAcsUrl") | .OutputValue][0] // ""' <<<"$outputs")"
  audience="$(jq -r '[.[] | select(.OutputKey == "CognitoSamlAudience") | .OutputValue][0] // ""' <<<"$outputs")"
  if [[ ! "$acs_url" =~ ^https:// ]] || [[ "$audience" != urn:amazon:cognito:sp:* ]]; then
    user_pool_id="$(jq -er '[.[] | select(.OutputKey == "UserPoolId") | .OutputValue][0]' <<<"$outputs")"
    if [[ "$AWS_PARTITION" == "aws-cn" ]]; then
      cognito_domain_suffix="amazoncognito.com.cn"
    else
      cognito_domain_suffix="amazoncognito.com"
    fi
    acs_url="https://$DOMAIN_PREFIX.auth.$(region).$cognito_domain_suffix/saml2/idpresponse"
    audience="urn:amazon:cognito:sp:$user_pool_id"
  fi
  say "SAML ACS URL: $acs_url"
  say "SAML audience: $audience"
}

if [[ -z "$IDENTITY_CENTER_METADATA_URL" && -z "$IDENTITY_CENTER_METADATA_FILE" ]] && \
  aws_cli cloudformation describe-stacks --stack-name "$(foundation_stack)" >/dev/null 2>&1; then
  say "Identity Center setup is required before this existing deployment can be updated"
  print_identity_center_setup
  fail "Assign an IAM Identity Center group to a custom SAML application, then set identityCenter.metadataUrl (preferred) or identityCenter.metadataFile"
fi

deploy_stack "$(network_stack)" templates/network.yaml \
  DeploymentName="$DEPLOYMENT" \
  NetworkMode="$(config '.networkMode')"

deploy_stack "$(foundation_stack)" templates/foundation.yaml \
  DeploymentName="$DEPLOYMENT" \
  CognitoDomainPrefix="$DOMAIN_PREFIX" \
  ConfigureCaseInsensitiveUsernames="$CONFIGURE_CASE_INSENSITIVE_USERNAMES"

if [[ -z "$IDENTITY_CENTER_METADATA_URL" && -z "$IDENTITY_CENTER_METADATA_FILE" ]]; then
  say "The identity bootstrap is ready"
  print_identity_center_setup
  say "Next: create and assign the IAM Identity Center SAML application, set identityCenter.metadataUrl (preferred) or identityCenter.metadataFile, and run deploy again"
  exit 0
fi

USER_POOL_ID="$(stack_output "$(foundation_stack)" UserPoolId)"
CLIENT_ID="$(stack_output "$(foundation_stack)" UserPoolClientId)"
CLIENT_SECRET_ARN="$(stack_output "$(foundation_stack)" CognitoClientSecretArn)"

configure_cognito_client() {
  local callback_urls_json="$1"
  local logout_urls_json="$2"
  local url
  local -a callback_urls=()
  local -a logout_urls=()
  while IFS= read -r url; do
    [[ -n "$url" ]] && callback_urls+=("$url")
  done < <(jq -r '.[]' <<<"$callback_urls_json")
  while IFS= read -r url; do
    [[ -n "$url" ]] && logout_urls+=("$url")
  done < <(jq -r '.[]' <<<"$logout_urls_json")
  [[ "${#callback_urls[@]}" -gt 0 && "${#logout_urls[@]}" -gt 0 ]] || \
    fail "Cognito callback and logout URLs cannot be empty"

  aws_cli cognito-idp update-user-pool-client \
    --user-pool-id "$USER_POOL_ID" \
    --client-id "$CLIENT_ID" \
    --supported-identity-providers IdentityCenter \
    --explicit-auth-flows ALLOW_REFRESH_TOKEN_AUTH \
    --allowed-o-auth-flows code \
    --allowed-o-auth-scopes openid email profile \
    --allowed-o-auth-flows-user-pool-client \
    --callback-urls "${callback_urls[@]}" \
    --logout-urls "${logout_urls[@]}" \
    --prevent-user-existence-errors ENABLED \
    --enable-token-revocation \
    --access-token-validity 60 \
    --id-token-validity 60 \
    --refresh-token-validity 1 \
    --token-validity-units AccessToken=minutes,IdToken=minutes,RefreshToken=days >/dev/null
}

say "Connecting the Cognito bridge to IAM Identity Center"
if [[ -n "$IDENTITY_CENTER_METADATA_URL" ]]; then
  IDENTITY_CENTER_PROVIDER_DETAILS="$(jq -cn \
    --arg metadataUrl "$IDENTITY_CENTER_METADATA_URL" \
    '{MetadataURL:$metadataUrl,IDPInit:"false",IDPSignout:"false",RequestSigningAlgorithm:"rsa-sha256"}')"
else
  IDENTITY_CENTER_PROVIDER_DETAILS="$(jq -cn \
    --rawfile metadata "$IDENTITY_CENTER_METADATA_FILE" \
    '{MetadataFile:$metadata,IDPInit:"false",IDPSignout:"false",RequestSigningAlgorithm:"rsa-sha256"}')"
fi
if aws_cli cognito-idp describe-identity-provider \
  --user-pool-id "$USER_POOL_ID" \
  --provider-name IdentityCenter >/dev/null 2>&1; then
  aws_cli cognito-idp update-identity-provider \
    --user-pool-id "$USER_POOL_ID" \
    --provider-name IdentityCenter \
    --provider-details "$IDENTITY_CENTER_PROVIDER_DETAILS" \
    --attribute-mapping email=email \
    --idp-identifiers identity-center >/dev/null
else
  aws_cli cognito-idp create-identity-provider \
    --user-pool-id "$USER_POOL_ID" \
    --provider-name IdentityCenter \
    --provider-type SAML \
    --provider-details "$IDENTITY_CENTER_PROVIDER_DETAILS" \
    --attribute-mapping email=email \
    --idp-identifiers identity-center >/dev/null
fi

CURRENT_CLIENT_URLS="$(aws_cli cognito-idp describe-user-pool-client \
  --user-pool-id "$USER_POOL_ID" \
  --client-id "$CLIENT_ID" \
  --query 'UserPoolClient.{callbacks:CallbackURLs,logouts:LogoutURLs}' \
  --output json)"
configure_cognito_client \
  "$(jq -c '.callbacks' <<<"$CURRENT_CLIENT_URLS")" \
  "$(jq -c '.logouts' <<<"$CURRENT_CLIENT_URLS")"

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
AWS_CLI_VERSION="$(config '.versions.awsCli')"
NODE_VERSION="$(config '.versions.node')"
BUN_VERSION="$(config '.versions.bun')"
CLAUDE_CODE_VERSION="$(config '.versions.claudeCode')"
CODEX_VERSION="$(config '.versions.codex')"
IMAGE_TEMPLATE_HASH="$(hash_text "$(<"$ROOT_DIR/templates/image.yaml")")"
IMAGE_COMPONENT_HASH="$(hash_text "$ARCHITECTURE:$AWS_CLI_VERSION:$NODE_VERSION:$BUN_VERSION:$CLAUDE_CODE_VERSION:$CODEX_VERSION:$IMAGE_TEMPLATE_HASH")"
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
  AwsCliVersion="$AWS_CLI_VERSION" \
  NodeVersion="$NODE_VERSION" \
  BunVersion="$BUN_VERSION" \
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

UPLOAD_BUCKET="$(stack_output "$(foundation_stack)" UploadBucketName)"
RUNTIME_TEMPLATE_HASH="$(hash_text "$(<"$ROOT_DIR/templates/runtime.yaml")")"
RUNTIME_TEMPLATE_KEY="provisioning/runtime-$RUNTIME_TEMPLATE_HASH.yaml"
RUNTIME_TEMPLATE_URL="https://$UPLOAD_BUCKET.s3.$(region).$AWS_URL_SUFFIX/$RUNTIME_TEMPLATE_KEY"
say "Publishing the reviewed runtime template under its content hash"
aws_cli s3 cp \
  "$ROOT_DIR/templates/runtime.yaml" \
  "s3://$UPLOAD_BUCKET/$RUNTIME_TEMPLATE_KEY" \
  --sse AES256 >/dev/null

CLAUDE_MODEL="$(config '.models.claude')"
CLAUDE_PROFILE="$(aws_cli bedrock get-inference-profile \
  --inference-profile-identifier "$CLAUDE_MODEL" \
  --output json)" || fail "The configured Claude inference profile is unavailable"
CLAUDE_PROFILE_ARN="$(jq -er '.inferenceProfileArn' <<<"$CLAUDE_PROFILE")"
CLAUDE_MODEL_ARNS="$(jq -er '[.models[].modelArn] | select(length > 0) | join(",")' <<<"$CLAUDE_PROFILE")"

deploy_stack "$(provisioning_stack)" templates/provisioning.yaml \
  DeploymentName="$DEPLOYMENT" \
  UserPoolId="$USER_POOL_ID" \
  UserRegistryTableName="$(stack_output "$(foundation_stack)" UserRegistryTableName)" \
  RuntimeTemplateUrl="$RUNTIME_TEMPLATE_URL" \
  RuntimeTemplateBucket="$UPLOAD_BUCKET" \
  RuntimeTemplateKey="$RUNTIME_TEMPLATE_KEY" \
  RuntimeSubnetId="$(stack_output "$(network_stack)" PrivateSubnetId)" \
  RuntimeSecurityGroupId="$(stack_output "$(network_stack)" RuntimeSecurityGroupId)" \
  RuntimeAmiId="$AMI_ID" \
  InstanceType="$(config '.runtime.instanceType')" \
  Architecture="$ARCHITECTURE" \
  VolumeSizeGiB="$(config '.runtime.volumeSizeGiB')" \
  ClaudeModelId="$CLAUDE_MODEL" \
  ClaudeInferenceProfileArn="$CLAUDE_PROFILE_ARN" \
  ClaudeFoundationModelArns="$CLAUDE_MODEL_ARNS" \
  CodexModelId="$(config '.models.codex')" \
  UploadBucketName="$UPLOAD_BUCKET"

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
    TerminalSessionDocumentName="$(stack_output "$(foundation_stack)" TerminalSessionDocumentName)" \
    ProvisioningStateMachineArn="$(stack_output "$(provisioning_stack)" StateMachineArn)"
}

INITIAL_PUBLIC_URL="$CONFIGURED_PUBLIC_URL"
if [[ -z "$INITIAL_PUBLIC_URL" ]]; then
  INITIAL_PUBLIC_URL="$(stack_output "$(web_stack)" ServiceUrl 2>/dev/null || true)"
fi
if [[ ! "$INITIAL_PUBLIC_URL" =~ ^https?:// ]]; then
  INITIAL_PUBLIC_URL='http://localhost:3000'
fi
deploy_web_stack "$INITIAL_PUBLIC_URL"

SERVICE_URL="$(stack_output "$(web_stack)" ServiceUrl)"
PUBLIC_URL="${CONFIGURED_PUBLIC_URL:-$SERVICE_URL}"
if [[ "$INITIAL_PUBLIC_URL" != "$PUBLIC_URL" ]]; then
  say "Applying the final public address to Auth.js"
  deploy_web_stack "$PUBLIC_URL"
fi
say "Updating Cognito callback URLs for the public web address"
configure_cognito_client \
  "$(jq -cn --arg publicUrl "$PUBLIC_URL" '[($publicUrl + "/api/auth/callback/cognito")]')" \
  "$(jq -cn --arg publicUrl "$PUBLIC_URL" '[($publicUrl + "/")]')"

say "Restricting browser uploads to the deployed web address"
UPLOAD_CORS_CONFIGURATION="$(jq -cn --arg publicUrl "$PUBLIC_URL" '{
  CORSRules: [{
    AllowedHeaders: ["content-type"],
    AllowedMethods: ["PUT"],
    AllowedOrigins: [$publicUrl],
    ExposeHeaders: ["ETag"],
    MaxAgeSeconds: 300
  }]
}')"
aws_cli s3api put-bucket-cors \
  --bucket "$(stack_output "$(foundation_stack)" UploadBucketName)" \
  --cors-configuration "$UPLOAD_CORS_CONFIGURATION"

cat >"$STATE_DIR/deployment.json" <<STATE
{"deploymentName":"$DEPLOYMENT","region":"$(region)","serviceUrl":"$PUBLIC_URL","appRunnerServiceUrl":"$SERVICE_URL","imageBuildVersionArn":"$IMAGE_ARN"}
STATE
chmod 0600 "$STATE_DIR/deployment.json"

say "AgentFormation deployment is ready: $PUBLIC_URL"
