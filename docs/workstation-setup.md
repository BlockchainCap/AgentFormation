# Prepare a workstation for AgentFormation

This guide prepares a macOS or Linux computer to check, deploy, or contribute to
AgentFormation. It also explains the platform names that commonly cause the
wrong AWS CLI or Docker package to be installed.

For a guided setup, start Codex from the repository root and invoke
`$setup-agentformation`. The skill inventories the computer and AWS profile
before recommending any change. It does not deploy or delete AWS resources
without a separate, explicit request.

## Operating system and CPU are separate facts

Run these commands first:

```bash
uname -s
uname -m
docker version --format '{{.Server.Os}}/{{.Server.Arch}}'
docker buildx version
```

`uname -s` reports the operating system. `uname -m` reports the CPU
architecture. The names used by operating systems, AWS, and Docker differ:

| Output or name       | Meaning                                       |
| -------------------- | --------------------------------------------- |
| `Darwin`             | macOS                                         |
| `Linux`              | Linux; this says nothing about the CPU        |
| `x86_64` or `amd64`  | The same 64-bit Intel/AMD CPU architecture    |
| `arm64` or `aarch64` | The same 64-bit ARM CPU architecture          |
| `linux/amd64`        | A Linux container for an Intel/AMD 64-bit CPU |
| `linux/arm64`        | A Linux container for a 64-bit ARM CPU        |

`amd64` does not mean “AMD computers only.” Intel 64-bit computers use the same
architecture. Likewise, Linux is not the opposite of AMD: Linux can run on
either `amd64` or `arm64`.

AgentFormation involves three independent platforms:

1. The **operator computer** can be macOS or Linux and can use either CPU
   architecture.
2. The **employee EC2 runtime** uses `runtime.architecture` from
   `agentformation.local.json`. The example uses AWS Graviton (`arm64`) with an
   `m7g.xlarge` instance.
3. The current **App Runner web image** is published as `linux/amd64`. The deploy
   script uses Docker Buildx so an ARM operator computer or ARM AgentFormation
   runtime can still build that image.

Do not change `runtime.architecture` merely because the operator computer has a
different CPU. Match the runtime value to the selected EC2 instance family.

## Install the required tools

An operator who runs `doctor` or `deploy` needs:

- Git;
- AWS CLI version 2;
- Docker with the Buildx plugin;
- `jq`; and
- the normal Unix shell tools included with current macOS and Linux systems.

A contributor who runs the full repository checks also needs the Node.js and Bun
versions pinned in `agentformation.example.json`, ShellCheck, and either
`cfn-lint` or `uvx`.

Use the vendors' current installation instructions rather than copying a package
from another computer:

- [AWS CLI version 2 installation](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
- [Docker Engine installation](https://docs.docker.com/engine/install/) or
  [Docker Desktop installation](https://docs.docker.com/desktop/)
- [Docker Buildx installation](https://docs.docker.com/build/install-buildx/)
- [Bun installation](https://bun.sh/docs/installation)
- [ShellCheck installation](https://github.com/koalaman/shellcheck#installing)
- [`uv` installation](https://docs.astral.sh/uv/getting-started/installation/)

On Linux, the AWS CLI download name must match `uname -m`:

| `uname -m`           | AWS CLI installer architecture |
| -------------------- | ------------------------------ |
| `x86_64`             | `x86_64`                       |
| `aarch64` or `arm64` | `aarch64`                      |

AWS publishes separate `awscli-exe-linux-x86_64.zip` and
`awscli-exe-linux-aarch64.zip` packages. Follow the signature-verification step
in the official AWS guide when using a downloaded archive. On macOS, use the
current macOS installer from that same guide.

Confirm the tools before continuing:

```bash
aws --version
docker version
docker buildx version
jq --version
git --version
```

For repository development, also confirm the pinned versions:

```bash
jq '.versions | {node, bun}' agentformation.example.json
node --version
bun --version
shellcheck --version
```

## Give the operator temporary AWS access

Use an IAM Identity Center profile with temporary credentials. Do not use the
AWS root user, create a long-lived IAM access key, run `aws configure` with a
static key, or copy `~/.aws/credentials` from another computer.

An organization administrator should assign the operator's Identity Center group
to the target AWS account with an appropriate permission set. A small test may
use a time-limited administrator permission set. A mature organization should
prefer a dedicated deployer permission set and, where required, the existing
CloudFormation execution role configured as `cloudFormationRoleArn`. The exact
least-privilege policy depends on the organization's guardrails and every AWS
service enabled by its AgentFormation configuration.

This AWS account assignment is separate from the AgentFormation application's
access group:

| Assignment                       | What it controls                                                  |
| -------------------------------- | ----------------------------------------------------------------- |
| AWS account + permission set     | What the operator may do in the AWS console and CLI               |
| AgentFormation application group | Which employees may open the web app and create their one runtime |

Being assigned to the app does not grant deployment permission. Having an AWS
account role does not automatically grant app access.

Configure a named profile on a computer with a browser:

```bash
aws configure sso --profile agentformation-operator
aws sso login --profile agentformation-operator
aws sts get-caller-identity --profile agentformation-operator
```

Use the organization's AWS access portal start URL and the Region where IAM
Identity Center is configured. Choose the intended AWS account and permission
set when prompted.

On a remote or headless computer, use the device-code flow so the approval can
be completed in a browser on another device:

```bash
aws configure sso --profile agentformation-operator --use-device-code
aws sso login --profile agentformation-operator --use-device-code
```

The profile contains configuration, while the CLI caches temporary Identity
Center tokens locally. Keep `~/.aws/` private and out of Git. When the work is
finished, `aws sso logout` removes cached Identity Center access for all local
SSO profiles, so confirm that signing out every profile is acceptable first.

AWS references:
[configure IAM Identity Center for the AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sso.html),
[assign groups and permission sets to an AWS account](https://docs.aws.amazon.com/singlesignon/latest/userguide/assignusers.html), and
[manage account access with permission sets](https://docs.aws.amazon.com/singlesignon/latest/userguide/permissionsetsconcept.html).

## Check the repository without deploying

Create the ignored local configuration, then select the profile explicitly:

```bash
cp agentformation.example.json agentformation.local.json
export AWS_PROFILE=agentformation-operator
./agentformation doctor
```

`doctor` validates the local configuration, required tools, AWS identity,
CloudFormation templates, and configured model availability. It does not create
or update an AgentFormation deployment. Review any failure before running
`./agentformation deploy`, which does change AWS resources and can create cost.

For source changes, run:

```bash
./scripts/check.sh
```

That command installs the frozen web dependencies, audits them, runs formatting,
lint, types, tests, and a production build, then checks the shell scripts and
CloudFormation templates.

## Common failures

- **The AWS account is absent during `aws configure sso`:** the Identity Center
  user or group lacks an account permission-set assignment. Changing the
  AgentFormation application group will not fix it.
- **The employee gets “No access” while opening AgentFormation:** verify the
  application's direct user or group assignment. Changing the CLI permission set
  will not fix it.
- **`Unable to locate credentials` or an expired-session message:** run
  `aws sso login --profile agentformation-operator` again.
- **`docker: 'buildx' is not a docker command`:** install or enable the Buildx
  plugin, then verify `docker buildx version`.
- **`exec format error` or `no matching manifest`:** an image or executable was
  built for the wrong CPU. Compare `uname -m`, the installer suffix, and the
  Docker target such as `linux/amd64`.
- **The runtime instance type is rejected:** Graviton families such as `m7g`
  require `arm64`; Intel/AMD families require `x86_64`.

After the workstation passes `doctor`, continue with the
[IAM Identity Center application setup](identity-center-setup.md) and the
[main quick start](../README.md#quick-start).
