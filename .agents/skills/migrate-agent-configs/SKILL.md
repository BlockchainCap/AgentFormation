---
name: migrate-agent-configs
description: Safely migrate a person's local Codex and Claude Code settings, session history, and explicitly approved credentials into their assigned AgentFormation runtime through AWS Systems Manager. Use for onboarding or restoring an existing AgentFormation runtime; do not use for an untrusted host or as a general EC2 backup tool.
---

# Migrate local agent configs

Move only the local agent state the user chooses into one existing,
user-assigned AgentFormation runtime. Preserve the public template's Bedrock
defaults unless the user explicitly asks to replace them.

Before acting, read
[the AgentFormation migration guide](../../../docs/migrating-local-agent-configs.md)
completely. Treat its security and cleanup rules as required.

## Establish the exact scope

Discover read-only facts before asking the user for anything the repository or
AWS account can answer:

- the AWS profile and region;
- the AgentFormation deployment and upload bucket;
- the exact managed EC2 instance assigned to this user;
- the local and remote home directories;
- which Codex and Claude Code files exist and their sizes; and
- whether the remote runtime already contains newer settings or sessions.

Show a short inventory grouped as settings, sessions/history, credentials, MCP
connections, source repositories, and disposable files. Get explicit approval
before moving any credentials or session history. Approval to migrate settings
does not include credentials, tokens, browser cookies, keychains, chat history,
or uncommitted source code.

## Hard boundaries

- Verify the target instance through trusted AgentFormation state, CloudFormation
  outputs, registry data, and the `AgentFormationManaged` tags. Never accept a
  browser-supplied or unverified instance ID.
- Touch only the selected user's runtime. Do not stop, update, or inspect another
  person's runtime.
- Never print secret values, include them in command arguments, commit them, or
  put them in SSM Run Command parameters. AWS retains command history.
- Never upload a plaintext archive. Client-side encrypt the archive before it
  leaves the source machine, even when the S3 bucket also encrypts objects.
- Keep the one-time private unwrap key on the destination runtime only. Return
  only its public key to the source machine.
- Use exact, random, user-scoped S3 object keys. Delete the exact objects after
  validation and verify that the temporary prefix is empty.
- Create local and remote scratch directories with `mktemp -d`. Record their
  exact paths, use a cleanup trap, and never run recursive deletion against a
  home directory, `/workspace`, a repository root, an unresolved variable, or a
  glob.
- Back up replaced remote files into a timestamped, permission-restricted folder
  before installing anything. Do not overwrite newer remote state without the
  user's approval.
- Merge approved local state with remote-only state. A previous partial migration
  or a currently used runtime must never be treated as an empty destination.
- Preserve owner and permissions. Credential files must be owned by the
  `agentformation` user and mode `0600`; private directories must be `0700`.
- Stop if the target identity is ambiguous, SSM is offline, encrypted staging is
  unavailable, archive integrity fails, or cleanup cannot be verified.

## Choose portable state

### Codex

Normally consider:

- `~/.codex/config.toml`, global `AGENTS.md`, rules, hooks, skills, and intentional
  plugin configuration;
- `~/.codex/sessions/`, archived sessions, history, memories, goals, and indexes
  when the user approves chat-history migration; and
- `~/.codex/auth.json` only when the user explicitly wants the remote runtime to
  use the same ChatGPT login instead of AgentFormation's default Bedrock provider.

Use SQLite's `.backup` command for live Codex databases instead of copying open
database files. Exclude logs, sockets, process state, temporary files, build
caches, macOS-only helpers, and bundled binaries that should be installed for the
remote architecture. Rewrite local absolute paths and disable non-portable MCP
servers instead of making them required and blocking Codex startup.

Inventory and compare every portable Codex category: configuration values,
status line, global instructions, rules, hooks, personal skills, intentional
plugin selections, MCP names, session files, archived sessions, prompt history,
session names, thread indexes, memories, and goals. Compare hashes or row counts
where practical without printing contents. Keep newer Linux-installed system
skills and plugins rather than replacing them with an older macOS cache.

OpenAI documents copying `~/.codex/auth.json` as a supported headless-login
fallback. It also says to treat that file like a password. If the source login is
in a keychain instead of the file, prefer a fresh remote `codex login
--device-auth`; do not export the keychain behind the user's back.

### Claude Code

Normally consider:

- `~/.claude/settings.json`, user instructions, skills, hooks, and intentional MCP
  configuration; and
- session/project history only when the user approves it after seeing its size.

`~/.claude.json` can contain sign-in state, MCP configuration, trust decisions,
and machine-specific project paths. Inspect its keys without printing values,
copy only the approved parts, and rewrite source-machine paths. AgentFormation's
default Claude Code setup uses the runtime's AWS role with Bedrock and needs no
personal Claude login. Prefer a fresh supported remote login over copying a
Claude credential or operating-system keychain.

Exclude debug logs, telemetry, caches, backups, sockets, lock files, and binaries.
Confirm the installed Claude Code version understands every migrated setting.

### Repositories and other tools

Prefer a fresh authenticated `git clone`. Use a Git bundle when the destination
must receive exact committed history without direct repository access. Move
uncommitted work only with separate, explicit approval and inspect it for secrets
first. Do not copy `node_modules`, build output, virtual environments, Docker
state, or platform-specific binaries.

Prefer fresh device login for GitHub and MCP services. OAuth tokens may be stored
in a local OS keychain and are intentionally not portable. On AgentFormation,
use the page's **OAuth** helper when a remote MCP login redirects the browser to
`127.0.0.1` or `localhost`.

Never migrate `~/.aws/credentials`, `~/.aws/sso/cache`, or `~/.aws/cli/cache`.
The AgentFormation runtime uses its attached instance role for its normal AWS
access. If the user also needs a personal operator profile on the remote host,
invoke `$setup-agentformation` there and complete a fresh IAM Identity Center
device-code login instead of copying credentials or cached tokens.

## Transfer through SSM

1. Generate a one-time asymmetric key pair inside the remote scratch directory
   through an SSM session or Run Command. Keep the private key remote and retrieve
   only the public key.
2. Build an allowlisted archive in the local scratch directory. Create consistent
   SQLite backups first. Record a manifest of paths, sizes, modes, and hashes
   without recording credential contents. On macOS, disable Apple archive
   metadata and reject AppleDouble entries such as `._payload`.
3. Generate a random symmetric secret locally, encrypt the archive, wrap the
   secret with the remote public key, and calculate a SHA-256 digest of the
   ciphertext. Never place the secret in a shell argument, SSM parameter, log, or
   S3 object name.
4. Upload only the ciphertext and wrapped secret to the existing encrypted
   AgentFormation upload bucket under the exact assigned user's prefix.
5. Through SSM, have the destination download the two objects with its instance
   role, verify the ciphertext digest, unwrap and decrypt inside the remote
   scratch directory, and reject unexpected archive paths before extraction.
6. Install the approved files as `agentformation`, normalizing Linux paths and
   permissions. Merge session/history data so newer remote-only chats survive.
   For migrated Codex history, back up the merged SQLite index, map copied
   rollout paths to the matching remote Codex `sessions/` or
   `archived_sessions/` directory, map copied unarchived user-chat working
   folders to the runtime start folder, and set `tui.resume_cwd = "current"`.
   Confirm every indexed rollout resolves to a regular file under one of those
   remote directories. Preserve the original paths in the restricted rollback
   copy; never rewrite message content merely to change a path.
   Keep the original AgentFormation Bedrock config as a clearly named backup
   whenever provider settings change.
7. Validate before deleting backups: start both CLIs, check their reported auth
   mode, list configured MCP servers, compare every approved settings category,
   and prove that ordinary `codex resume -C /workspace` lists migrated interactive
   chats. Also run
   `codex resume --all --include-non-interactive -C /workspace` and directly
   resume one approved session by ID if history was copied. File counts or
   database row counts alone do not validate a migration. Perform a harmless
   read-only prompt when the chosen provider permits it.
8. Remove the exact S3 objects, one-time remote key material, decrypted archive,
   local scratch directory, and temporary token files. Verify each is gone. Keep
   the timestamped remote rollback copy until the user accepts the migration.

## Report the result

State which categories matched already, which moved, which were merged, which
were deliberately skipped, the target instance, the validation performed,
whether the default Bedrock provider changed, where the rollback copy lives, and
whether every temporary local, S3, and remote artifact was removed. Never claim
completion from file presence alone, and never include credential values or full
sensitive paths in the report.
