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
Permission to update an AgentFormation CloudFormation stack is administrative
access to that deployment. Stack parameters select trusted roles, tables,
secrets, images, and runtime resources, so operators should limit stack updates
to the same dedicated deployers they trust with the underlying AWS resources.
An optional `cloudFormationRoleArn` limits what CloudFormation can create; it
does not make an untrusted `UpdateStack` caller safe.

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
session-start API. Browser resume and termination requests carry an expiring
HMAC proof that binds the Systems Manager session ID to both the signed-in
subject and the currently assigned runtime instance. The server consistently
re-reads that assignment immediately before each privileged runtime action.

Systems Manager returns a short-lived token and regional WebSocket address so a
Session Manager client can open the data channel. AgentFormation passes those
values to the signed-in browser, validates that the address is the expected
regional `ssmmessages` host and session path, and limits the Content Security
Policy to that AWS endpoint. The browser never receives the EC2 role credentials.

State-changing environment, terminal, upload, and OAuth-relay routes accept only
same-origin JSON requests. They authenticate before parsing a body and stop
reading JSON after a small fixed limit. Their success and error responses disable
browser and intermediary caching. The web app uses a new script nonce for every
request instead of allowing arbitrary inline scripts in its Content Security
Policy.

A second, short-lived DynamoDB table holds atomic request counters, in-flight
operation leases, termination deduplication records, and upload-completion
claims. Because all App Runner instances use the same table, switching instances
or restarting the service does not reset these controls. Limits are per federated
subject: environment creation is capped at four starts per hour; upload staging
is capped at 60 files and 2 GiB per hour; terminal and relay calls have narrower
minute or hourly limits. One privileged operation of the same kind is allowed in
flight for a subject and resource at a time. Expiring records are removed by
DynamoDB TTL.

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

The web role cannot use the general-purpose `AWS-RunShellScript` document.
Uploads and OAuth callbacks each use a separate, deployment-owned command
document whose parameters have strict character patterns and are exposed to the
script only as environment variables. The documents contain fixed commands,
and every callback and upload operation runs as the unprivileged
`agentformation` user. This keeps a web-service compromise from turning the
file-transfer path into an arbitrary root command.

Browser file uploads use a one-key presigned POST whose policy enforces a 50 MiB
write limit. Before returning that policy, the server records the exact subject,
runtime, key, filename, content type, and size. Completion atomically claims that
record once, copies the matching object generation to a server-owned sealed key,
revalidates the runtime assignment, and only then asks the runtime to download
it. The runtime downloads to a private temporary filename, verifies the byte
count, and atomically renames the complete file into its visible destination.
If command completion cannot be confirmed, the upload claim stays in its
in-progress state until its TTL; that claim, rather than the shorter request
lease, prevents a duplicate delivery while the command may still be running.

## Self-service environment creation

A signed-in employee can ask the App Runner service to start one fixed Step
Functions job. The web role can start that exact job and read the safe status
fields from events for the authenticated subject's deterministic runtime stack;
it cannot create, update, or delete CloudFormation stacks.

The job:

1. confirms that the Cognito subject identifies exactly one enabled federated
   user in this user pool;
2. conditionally reserves one DynamoDB record for that subject;
3. uses an opaque, deterministic runtime stack name derived from the subject;
4. creates only the reviewed runtime template uploaded under its SHA-256 content
   hash;
5. supplies network, AMI, instance size, volume, model, and upload settings chosen
   by the operator during deployment; and
6. polls CloudFormation and instance discovery for bounded periods;
7. confirms the federated user is still enabled immediately before activation;
8. records the resulting tagged EC2 instance only after CloudFormation succeeds;
   and
9. deletes a failed or superseded runtime stack before making a clean retry
   available.

The active runtime template remains stored under its content hash for as long as
the deployment uses it. After a successful update, older template hashes receive
a superseded tag and a fresh 30-day retirement window so both stable deployments
and already-running setup jobs keep a valid template.

A separate CloudFormation service role can create only the named AgentFormation
runtime IAM roles, the operator-selected AMI/network dependencies, and tagged
runtime instances. The setup job cannot accept a browser-provided template URL,
AMI, subnet, security group, IAM policy, model, or instance size.

The DynamoDB conditional write makes repeated button presses idempotent: an active
or current in-progress employee record is not replaced. A failed setup is
eligible for immediate retry after cleanup. A setup still marked as provisioning
becomes retryable after 100 minutes, beyond the workflow's 90-minute hard timeout.
Every retry is reconciled against the deterministic stack before the same
reviewed stack name is reused, and activation/failure writes must still match the
exact reservation start time.

## Network and host controls

- Runtime instances are in a private subnet with no public IPv4 address.
- Their security group has no inbound rules.
- Browser terminals use AWS Systems Manager Session Manager; SSH is not opened.
- EC2 instance metadata requires IMDSv2.
- Runtime EBS volumes and staged uploads are encrypted at rest.
- The upload bucket rejects requests that do not use HTTPS.
- Upload objects expire after one day and are deleted after they reach a runtime.
- Full teardown removes the web service first, stops and confirms every running
  provisioning job, removes the setup state machine, and only then enumerates
  runtime stacks. It also cancels active image builds and removes deployment-tagged
  AMIs and snapshots before deleting the image pipeline. Teardown temporarily
  blocks all writes to the staging bucket while every current object, version,
  and delete marker is removed. If teardown stops before the foundation stack is
  deleted, the sanitized original bucket policy is restored.
- The default network uses one NAT gateway. Optional AWS service endpoints reduce
  some traffic through that gateway but do not remove the need for internet access
  to Git hosts, package registries, and similar developer services.

Runtime internet access is intentional: a general coding environment needs to
reach source hosts, package registries, and the APIs its owner chooses to use.
The runtime security group therefore allows outbound traffic while allowing no
inbound connections. Organizations that require destination filtering should add
their normal egress proxy, DNS policy, or network firewall and allow the developer
services they support; the reference template cannot guess a safe universal host
allowlist.

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

The runtime image pins the AWS CLI, Node.js, Bun, Claude Code, and Codex versions.
The AWS, Node.js, Bun, and Codex downloads are checksum-checked before execution.
AWS's installer
then verifies the AWS CLI package signature with its embedded AWS CLI team key;
the Codex installer verifies the selected release archive digest.

The App Runner image is pushed to the foundation stack's ECR repository, read
back from ECR by digest, and deployed with that immutable digest rather than a
mutable tag. The deploy command rejects a repository outside the current AWS
account and Region.

The Image Builder parent identifier deliberately follows AWS's `x.x.x` form for
the selected Ubuntu LTS stream so a newly built image receives AWS's current
patched base. Every completed AMI is immutable, recorded by ID, and used only for
environments created from that reviewed build. Operators who need a frozen base
version can pin the parent identifier, but then take responsibility for advancing
it when AWS publishes security updates.

## User lifecycle

- Assigning an Identity Center group allows its members to sign in. Each member can
  create one runtime from the fixed setup job.
- `users disable` disables the federated Cognito profile, requests Cognito's
  global token revocation, moves any registry record to a non-active state,
  terminates active Session Manager connections, and stops EC2 while preserving
  its encrypted disk.
- `users enable` starts the preserved instance, re-enables the profile, and restores
  the active registry record.
- `users purge --confirm DELETE` first revokes live access and stops matching
  provisioning, then places a conditional purge lock on the exact disabled
  registry record. Re-enable refuses that lock. Purge rechecks Cognito before it
  deletes every runtime stack tagged for that deployment and subject, its
  persistent disk, and the federated profile. Before any deletion, a re-enabled
  profile aborts purge and releases the exact lock. After profile deletion, the
  locked row is atomically replaced with a privacy-minimal `purged` marker that
  contains only the subject, status, update time, and DynamoDB expiry time. The
  marker remains for two hours. Every Auth.js token refresh checks that marker
  and clears a revoked session; a browser that never refreshes expires within
  one hour. Old browser sessions therefore cannot outlive the marker or create
  another runtime before DynamoDB expires it.

Remove the Identity Center application or group assignment as the source-of-truth
offboarding step. If an assigned employee is purged but remains assigned, their
next valid company sign-in can create a new federated profile and runtime.

Signing out of AgentFormation clears the app session and that browser's saved tab
metadata. It intentionally does not sign the person out of IAM Identity Center,
because that organization-wide session may also be serving other company apps.
As a result, signing back in can be immediate while the Identity Center session
is still valid. AgentFormation app sessions expire after one hour.

Group removal prevents the next federation but cannot recall an already-issued
application session by itself. Use `users disable` for immediate app-side
revocation: it disables the Cognito profile, requests Cognito's global token
revocation, and changes the runtime registry so every new privileged request
fails even if an already-issued app session has not expired. It also stops an
in-progress setup and the EC2 instance. An already-open Systems Manager data
channel can remain usable only until the instance stop or session termination
reaches it.

## Compromise scope

The App Runner role can start the fixed setup job for an enabled federated subject
and can manage terminal sessions and staged uploads across all tagged runtimes in
this deployment. Its shared request-control table protects AWS capacity from an
abusive signed-in caller, but it is not a boundary against compromise of the web
role itself. A compromise of the service role or server application can
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
