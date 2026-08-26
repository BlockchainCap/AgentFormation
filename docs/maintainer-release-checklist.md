# Maintainer release checklist

Public pull-request checks intentionally do not receive AWS credentials. Before a
release that changes infrastructure, authentication, runtime images, environment
creation, or terminal behavior, a maintainer should use a dedicated test AWS
account and complete this checklist.

- Run `./scripts/check.sh` from a clean checkout and confirm the dependency audit
  reports no known vulnerabilities.
- Scan the complete Git history for accidentally committed secrets. The same
  pinned Gitleaks image runs in pull requests:

  ```bash
  docker run --rm --volume "$PWD:/repo" \
    zricethezav/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f \
    git /repo --redact --no-banner
  ```

- Confirm the configured AWS CLI, Node.js, Bun, Claude Code, and Codex versions
  still exist at their official distribution sources. Refresh installer hashes
  only after reviewing the downloaded files.
- Leave both `identityCenter.metadataUrl` and `identityCenter.metadataFile` empty
  and run `./agentformation deploy`. Confirm it creates only the identity
  bootstrap, prints the SAML ACS URL and audience, and exits successfully before
  publishing a web service.
- Create a customer-managed IAM Identity Center SAML application in the test
  organization, map `Subject` to `${user:subject}` with the `persistent` format,
  map `email` to `${user:email}` with the `unspecified` format, and assign one
  dedicated test group. Add the test user directly; nested-group membership does
  not satisfy an application assignment.
- Copy the IAM Identity Center metadata HTTPS address into the ignored
  `agentformation.local.json`, set `identityCenter.metadataUrl`, and complete
  `./agentformation deploy`. Confirm the address is absent from Git diffs and
  command output.
- When updating a deployment created by an older AgentFormation release, confirm
  the deploy preserves the existing Cognito username case-sensitivity setting
  instead of attempting to replace the user pool.
- Test the downloaded-XML fallback at least once before a release that changes
  metadata handling: leave `metadataUrl` empty, put the XML in the ignored
  `.agentformation/` directory, set `identityCenter.metadataFile`, and rerun the
  doctor and deployment.
- Confirm the first build warning is accurate and record total deployment time.
- Sign in as a real assigned Identity Center user. Confirm AgentFormation asks for
  no separate username, password, or MFA setup.
- For a newly assigned app, sign out of the AWS access portal and sign back in so
  the test does not rely on the existing session's hourly application refresh.
- With an active company SSO session, confirm the app returns without another
  credential prompt.
- Confirm an unassigned Identity Center user is rejected before reaching the app.
- Choose **Create environment** and confirm one fixed setup job creates one runtime.
  Press the button twice or repeat the POST and confirm no second runtime appears.
- Confirm the user starts in `/workspace`.
- Run `claude --version` and `codex --version`.
- Make one harmless Bedrock request through each CLI.
- Create a file, disconnect, reconnect, and confirm the `tmux` process and file
  persist.
- Upload a harmless file and confirm it lands under `/workspace/.uploads`.
- Sign in as a second assigned test identity and verify the first user's requests
  cannot select or access the second runtime.
- Confirm cross-site and non-JSON environment, terminal, and upload requests are
  rejected, API responses are not cached, and the production script policy has no
  `unsafe-inline` allowance.
- Confirm the web role can start only the named setup job and cannot call
  CloudFormation directly.
- Confirm the setup job rejects a nonexistent or disabled Cognito subject and can
  use only the content-hashed runtime template and operator-selected settings.
- Confirm the runtime CloudFormation role cannot launch a different AMI, subnet,
  security group, or untagged instance.
- Confirm the Claude runtime role can invoke its configured inference profile but
  cannot invoke an unrelated foundation model directly.
- Disable the first identity and confirm app access is blocked and EC2 is stopping.
- Enable it and confirm the preserved runtime and files return.
- Remove its Identity Center group assignment and confirm a fresh sign-in is
  rejected.
- Purge the test identity and verify its stack and volume are gone.
- Review findings in the account or organization IAM Access Analyzer. AgentFormation
  intentionally does not create this account-wide service; if no analyzer exists,
  record that operator gap instead of marking the review complete.
- Confirm the ECR scan for the exact web image tag completed, then review every
  reported finding before release.
- Run `./agentformation destroy --confirm DELETE` after the review window and
  verify no tagged EC2, EBS, NAT, App Runner, ECR, S3, DynamoDB, Cognito, Secrets
  Manager, Step Functions, Image Builder, AMI, or snapshot resources remain.

Do not paste account IDs, user emails, SAML metadata addresses or XML, secrets,
session tokens, terminal contents, or private resource URLs into public release
notes.
