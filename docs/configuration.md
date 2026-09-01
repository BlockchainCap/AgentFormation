# Configure and move an AgentFormation deployment

`agentformation.local.json` is the only operator-edited deployment file. It is
ignored by Git because it can contain a company web address, an IAM role ARN, and
IAM Identity Center metadata. Start from the public example instead of copying a
config from an unrelated AWS account:

```bash
cp agentformation.example.json agentformation.local.json
```

## Configuration fields

| Field                         | What to enter                                                                 | When to change it                                                                                                                             |
| ----------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `deploymentName`              | A lowercase name using letters, numbers, and hyphens; do not use the reserved `-runtime-` segment | Keep it stable for the life of one deployment. Changing it creates a separate set of AWS resources.                                           |
| `region`                      | The AWS Region for the deployment                                             | Choose a Region supported by the required AWS services and configured Bedrock models.                                                         |
| `publicUrl`                   | Empty, or the exact `https://` origin of an active App Runner custom domain   | Leave empty for the generated App Runner address. Do not add a path or trailing slash.                                                        |
| `networkMode`                 | `private-nat` or `private-endpoints`                                          | `private-nat` is the normal starting point. The endpoint mode adds AWS service endpoints but still keeps internet access for developer tools. |
| `identityCenter.metadataUrl`  | The private HTTPS metadata address from the customer-managed SAML application | Preferred after the first identity bootstrap. Set only this field or `metadataFile`.                                                          |
| `identityCenter.metadataFile` | A local path to downloaded SAML metadata XML                                  | Use only when IAM Identity Center does not provide a metadata address. A path under `.agentformation/` stays out of Git.                      |
| `cloudFormationRoleArn`       | An optional, existing CloudFormation service role ARN                         | Add it only when the AWS account requires CloudFormation to use that role.                                                                    |
| `runtime.architecture`        | `arm64` (`aarch64`) or `x86_64` (`amd64`)                                     | It must match the selected instance family, not the operator computer. ARM is the example default.                                            |
| `runtime.instanceType`        | The EC2 type for each employee environment                                    | Review cost and memory before inviting a group.                                                                                               |
| `runtime.volumeSizeGiB`       | Persistent disk size, from 20 through 1024 GiB                                | Increasing the default affects newly created environments.                                                                                    |
| `models.claude`               | An active Bedrock inference-profile ID                                        | The deploy check resolves the profile and limits the runtime role to that profile and its current destination models.                         |
| `models.codex`                | The Bedrock model ID used by Codex                                            | Confirm access, provider terms, and quotas in the deployment Region.                                                                          |
| `versions.*`                  | Exact AWS CLI, Node.js, Bun, Claude Code, and Codex versions                  | Keep exact versions. A maintainer should update and test them deliberately.                                                                   |

Run this after every config edit:

```bash
AWS_PROFILE=your-profile ./agentformation doctor
```

The command checks the file shape, local tools, AWS identity, templates, and
model availability without printing private metadata or credentials.

## Architecture names and build targets

`runtime.architecture` controls the employee EC2 runtime only. It is independent
of the computer running `./agentformation deploy`:

- `arm64` is also called `aarch64` and matches AWS Graviton instance families
  such as `m7g`;
- `x86_64` is also called `amd64` and matches 64-bit Intel/AMD instance
  families; and
- Linux and macOS are operating systems, not CPU architectures.

The current App Runner web image target is `linux/amd64`. Docker Buildx lets a
macOS or Linux ARM host build that target without changing the employee runtime
architecture. See the [workstation setup guide](workstation-setup.md) for
detection commands, installer selection, and architecture-error troubleshooting.

## Move an existing deployment config to another computer

Build a new file from `agentformation.example.json` and copy approved values
field by field. This makes new required fields visible and prevents stale state
from following the config.

For the same AWS deployment, keep these values unchanged:

- `deploymentName`, `region`, `networkMode`, runtime sizing, models, and versions;
- `publicUrl` when the same custom domain is still active;
- `cloudFormationRoleArn` when the account still requires it; and
- the IAM Identity Center metadata address, transferred through an approved
  private channel.

Do not copy generated passwords, AWS keys, browser cookies, terminal output, or
the whole `.agentformation/` directory. That directory contains machine-local
deployment state and temporary authentication files. When a downloaded metadata
file is the only available source, transfer just that XML through an approved
private channel, save it under the new checkout's `.agentformation/` directory,
and keep its config path relative to the repo.

Then verify the new computer against AWS before changing anything:

```bash
AWS_PROFILE=your-profile ./agentformation doctor
AWS_PROFILE=your-profile ./agentformation status
```

If both commands identify the expected deployment, `./agentformation deploy`
can safely apply reviewed changes. Do not change `deploymentName` merely to make
the local checkout look different; that name controls the AWS resource set.

## Move a config from the earlier invited-user release

Older configs had a top-level `users` array and no Identity Center metadata or
pinned AWS CLI, Node.js, or Bun version. Use a fresh example and carry over only
the still-valid fields:

1. Keep the existing `deploymentName`, `region`, network choice, runtime size,
   model IDs, Node.js version, Claude Code version, Codex version, and optional CloudFormation
   role.
2. Add `publicUrl`, `identityCenter`, `versions.awsCli`, `versions.node`, and
   `versions.bun` from the current example.
3. Remove `users`. IAM Identity Center application assignment now controls who
   can sign in; the old email list is ignored.
4. Leave both metadata fields empty for the first upgrade run only if this is a
   brand-new deployment. For an existing stack, complete the Identity Center
   application first and set its metadata source before upgrading.
5. Run `doctor`, read the plan, and keep a private copy of the old local config
   until the upgraded sign-in and one test environment have been verified.

The deployment preserves the immutable username behavior of an older Cognito
pool rather than replacing the pool. The workforce release changes sign-in and
provisioning, so follow the full
[IAM Identity Center setup](identity-center-setup.md) and the
[maintainer release checklist](maintainer-release-checklist.md) before inviting
more employees.

## Move personal Codex or Claude Code settings

Deployment configuration and a person's agent settings are separate jobs. Do not
put `~/.codex`, `~/.claude`, chat history, provider tokens, or MCP credentials in
`agentformation.local.json`.

After the person's environment is ready, follow the
[agent settings migration guide](migrating-local-agent-configs.md). The included
`$migrate-agent-configs` skill starts with a read-only inventory, asks separately
before moving credentials or chats, encrypts staged data before upload, preserves
newer remote files, and verifies that migrated chats actually appear in
`codex resume`.

## Runtime and image updates

New runtime images include the pinned AWS CLI, Bun, Claude Code, Codex, Git,
Docker, Node.js/npm, `jq`, `ripgrep`, and `tmux`. Users land in `/workspace` and
can clone projects into named folders underneath it.

`AGENTFORMATION_REBUILD_IMAGE=1 ./agentformation deploy` creates and tests a new
image for environments created afterward. It does not silently replace an
existing employee's persistent EC2 instance. Plan existing-runtime upgrades
separately so workspace data and personal settings are backed up and verified.

## Common setup mistakes

- A first identity-bootstrap deploy prints the SAML ACS URL and audience, then
  exits successfully. Create the IAM Identity Center application and run deploy
  again with its metadata source.
- Set exactly one of `identityCenter.metadataUrl` and
  `identityCenter.metadataFile`.
- A custom `publicUrl` must already be active in App Runner and must contain only
  the HTTPS origin.
- The Claude value must be an inference-profile ID, not an arbitrary model name.
- The instance family must match `runtime.architecture`; do not copy the
  operator computer's architecture into this field by habit.
- Never commit the local config, metadata XML, `.env` files, or
  `.agentformation/` state.
