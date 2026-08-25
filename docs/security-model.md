# Security model

## Trust boundaries

AgentFormation has three important trust levels:

- An employee assigned to the IAM Identity Center application is trusted only
  inside that employee's own runtime.
- The App Runner service and its AWS role are trusted across this AgentFormation
  deployment. A compromise there can affect managed runtimes, as described below.
- The AWS account administrator is fully trusted. Administrators can use IAM,
  Systems Manager, EC2, snapshots, logs, or CloudFormation to inspect or change
  any runtime.

AgentFormation does not claim to protect runtime data from the AWS account owner.

## Company sign-in

IAM Identity Center application assignment is the front door. Operators should
normally assign a dedicated AgentFormation access group and remove employees from
that group when access should end. Members must be added directly because Identity
Center application assignments do not support nested groups. Reusing a broader
employee or developer group is appropriate only when every direct member should be
allowed to create a runtime and incur its AWS cost. The AWS root user is a separate
emergency identity and is not a supported app login. An AWS permission set such as
PowerUser is also not a login; it can be associated with the same employees, but
AgentFormation relies only on the separate application assignment.

Amazon Cognito is an invisible SAML-to-OIDC bridge. The web app sends users
straight to the `IdentityCenter` SAML provider. The app client excludes Cognito
local sign-in after setup, self-sign-up is unavailable, and AgentFormation stores
no employee password or separate MFA setting. The organization's existing sign-in
and MFA policy remains in control.

The operator supplies Cognito with either the IAM Identity Center metadata HTTPS
address or a downloaded metadata XML file. The address is preferred because
Cognito refreshes signing metadata automatically. Both forms are
organization-specific deployment configuration and stay outside Git.

Identity Center emits an employee email. Cognito creates a stable federated `sub`
identifier, which becomes the runtime authorization key. Email is kept for display
and administration, but browser requests cannot use an email address to select a
runtime.

## Runtime isolation

For every terminal or upload request, the server:

1. verifies the Auth.js session;
2. reads the federated Cognito subject from that session;
3. retrieves the matching DynamoDB record;
4. requires the record to be active; and
5. targets only the instance in that record.

The client never submits an instance ID. Runtime IDs are not returned by the
session-start API. Browser termination requests also carry an HMAC proof that
binds the Systems Manager session ID to the signed-in subject.

State-changing environment, terminal, upload, and OAuth-relay routes accept only
same-origin JSON requests. Their success and error responses disable browser and
intermediary caching. The web app uses a new script nonce for every request instead
of allowing arbitrary inline scripts in its Content Security Policy.

The OAuth relay exists for command-line tools that listen for a one-time callback
inside the private runtime. It accepts only plain HTTP URLs whose host is exactly
`localhost` or `127.0.0.1`, whose port is numeric, and whose path is `/callback` or
`/callback/<request-id>` with a URL-safe request ID. It rejects credentials,
fragments, nested paths, and non-local hosts, normalizes the destination to
`127.0.0.1`, and delivers the callback through Systems Manager only to the runtime
mapped from the signed-in federated subject.

The callback value is staged briefly in the encrypted, one-day upload bucket
under that subject's private prefix. Systems Manager command history contains
only the random object reference, not the OAuth code. The runtime reads the
object with its own restricted role, stores it in a private temporary file, and
removes that file after the request. The web service deletes the staging object
after the command; the bucket lifecycle is a cleanup backstop.

## Self-service environment creation

A signed-in employee can ask the App Runner service to start one fixed Step
Functions job. The web role can start that exact job; it cannot call
CloudFormation itself.

The job:

1. confirms that the Cognito subject identifies exactly one enabled federated
   user in this user pool;
2. conditionally reserves one DynamoDB record for that subject;
3. uses an opaque, deterministic runtime stack name derived from the subject;
4. creates only the reviewed runtime template uploaded under its SHA-256 content
   hash;
5. supplies network, AMI, instance size, volume, model, and upload settings chosen
   by the operator during deployment; and
6. records the resulting tagged EC2 instance only after CloudFormation succeeds.

A separate CloudFormation service role can create only the named AgentFormation
runtime IAM roles, the operator-selected AMI/network dependencies, and tagged
runtime instances. The setup job cannot accept a browser-provided template URL,
AMI, subnet, security group, IAM policy, model, or instance size.

The DynamoDB conditional write makes repeated button presses idempotent: an active
or in-progress employee record is not replaced. A failed setup can be retried
using the same reviewed stack name.

## Network and host controls

- Runtime instances are in a private subnet with no public IPv4 address.
- Their security group has no inbound rules.
- Browser terminals use AWS Systems Manager Session Manager; SSH is not opened.
- EC2 instance metadata requires IMDSv2.
- Runtime EBS volumes and staged uploads are encrypted at rest.
- The upload bucket rejects requests that do not use HTTPS.
- Upload objects expire after one day and are deleted after they reach a runtime.
- The default network uses one NAT gateway. Optional AWS service endpoints reduce
  some traffic through that gateway but do not remove the need for internet access
  to Git hosts, package registries, and similar developer services.

## Credentials and model access

The runtime uses its EC2 instance role. Long-lived AWS access keys are not placed
on disk by the template. Claude Code and Codex use the normal AWS credential chain
and are configured for Amazon Bedrock.

Claude Code uses Bedrock's native runtime endpoint. Before each runtime deployment,
the installer resolves the configured inference profile and its current destination
model ARNs. The runtime role can invoke only that profile and those foundation
models, and the foundation models can be invoked only through that profile.

Codex uses Bedrock's OpenAI-compatible Mantle endpoint. Its inference permission
is restricted to the configured Codex model and the account's `default` Bedrock
project. The role can request first-use model enablement only when the call comes
through `bedrock-mantle.amazonaws.com`; it cannot call AWS Marketplace directly.
These permissions follow AWS's Mantle inference policy pattern while avoiding the
broader AWS-managed policy.

Bedrock access, provider terms, quotas, and regional model availability are
controlled separately by AWS.

The runtime image pins the AWS CLI, Claude Code, and Codex versions. The AWS and
Codex installer scripts are checksum-checked before execution. AWS's installer
then verifies the AWS CLI package signature with its embedded AWS CLI team key;
the Codex installer verifies the selected release archive digest.

## User lifecycle

- Assigning an Identity Center group allows its members to sign in. Each member can
  create one runtime from the fixed setup job.
- `users disable` disables the federated Cognito profile, marks the registry record
  disabled, and stops EC2 while preserving its encrypted disk.
- `users enable` starts the preserved instance, re-enables the profile, and restores
  the active registry record.
- `users purge --confirm DELETE` deletes the federated profile, CloudFormation
  runtime, and persistent disk.

Remove the Identity Center application or group assignment as the source-of-truth
offboarding step. If an assigned employee is purged but remains assigned, their
next valid company sign-in can create a new federated profile and runtime.

An already-open Systems Manager terminal may remain usable briefly while disable
or group removal propagates. Use `users disable` and terminate active Systems
Manager sessions when immediate eviction is required.

## Compromise scope

The App Runner role can start the fixed setup job for an enabled federated subject
and can manage terminal sessions and staged uploads across all tagged runtimes in
this deployment. A compromise of the service role or server application can
therefore affect every managed runtime. It still cannot submit an arbitrary
CloudFormation template or choose more privileged runtime settings.

Keep dependencies current, restrict who can publish the web image or update the
stacks, and monitor the account using the organization's normal AWS controls.

## Known limits

- This is a reference project, not a formally audited security product.
- The web terminal depends on an npm package that implements the Session Manager
  browser protocol. Review dependency changes carefully.
- The template does not enable an account-wide web firewall, VPC flow logs,
  CloudTrail trail, GuardDuty, or Security Hub. Operators should apply their
  account's monitoring and retention policy separately.
- No backup or disaster-recovery policy is created for runtime EBS volumes.
- A single availability zone and NAT gateway keep the template understandable but
  are not a high-availability design.
