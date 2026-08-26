---
name: setup-agentformation
description: Prepare a macOS or Linux computer to check, deploy, or contribute to AgentFormation, including secure AWS CLI Identity Center sign-in and correct amd64 versus arm64 tool selection. Use for first-time setup or platform and AWS-profile troubleshooting; do not use it to deploy or delete AWS resources without a separate request.
---

# Set up AgentFormation

Prepare the current computer without changing AWS resources. Before acting, read
[the workstation setup guide](../../../docs/workstation-setup.md) completely and
follow its security and platform rules.

## Start with a read-only inventory

Identify these facts before recommending an installer or AWS change:

- operating system from `uname -s`;
- CPU architecture from `uname -m`;
- Docker server operating system and architecture;
- whether Docker Buildx, AWS CLI version 2, Git, and `jq` are available;
- whether contributor-only tools are needed; and
- existing AWS profile names and the intended deployment Region.

Do not read credential files or cached SSO tokens. It is appropriate to show the
current caller identity in the user's own terminal for verification, but do not
copy account IDs, role ARNs, or organization-specific Identity Center addresses
into reports, commits, issues, or logs.

## Keep platform names straight

Treat the operator OS, operator CPU, employee runtime architecture, and web-image
target as separate choices. `amd64` and `x86_64` are two names for one CPU
architecture; `arm64` and `aarch64` are two names for another. Linux is an
operating system and can run on either CPU.

Choose downloaded binaries from the detected CPU architecture. Do not copy
binaries, package caches, or agent plugins from a different OS or architecture.
Do not change `runtime.architecture` to match the operator computer; match it to
the selected EC2 instance family. AgentFormation's current web-image target is
`linux/amd64`, and Docker Buildx handles an ARM build host.

## Configure AWS safely

Prefer a named IAM Identity Center profile that returns temporary credentials:

```bash
aws configure sso --profile agentformation-operator
aws sso login --profile agentformation-operator
aws sts get-caller-identity --profile agentformation-operator
```

Use `--use-device-code` for both configure and login on a remote or headless
host. Never use the AWS root user, create or copy static access keys, copy an SSO
cache between computers, or commit anything under `~/.aws/`.

Distinguish the two Identity Center assignments when diagnosing access:

- an AWS account permission set controls the operator's console and CLI access;
- the AgentFormation application group controls employee web-app access only.

Recommend least privilege. If the deployment creates IAM resources and the
organization does not provide a CloudFormation execution role, explain that a
generic PowerUser permission set may be insufficient; do not silently broaden
the operator's access.

## Verify before any deployment

Use the selected profile explicitly and run `./agentformation doctor`. For source
work, also run `./scripts/check.sh`. Explain failures using the workstation guide
and fix only the local setup the user authorized.

`doctor` is the stopping point for setup. Treat `deploy`, `destroy`, user
disable/enable/purge commands, permission-set changes, and application-group
changes as separate AWS mutations that require the user's explicit request.

At handoff, report the detected platform, installed tool status, selected profile
name, `doctor` result, contributor-check result when applicable, and anything the
organization administrator must assign. Keep private AWS identifiers out of the
report.
