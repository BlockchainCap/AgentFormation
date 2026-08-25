# Migrate local Codex and Claude Code settings

AgentFormation starts each runtime with clean Codex and Claude Code installations
configured for Amazon Bedrock. After the runtime is working, an operator can
optionally move a person's existing preferences, skills, and approved session
history from a trusted computer into that person's assigned runtime.

This is an operator task. It requires an AWS profile that can identify the
assigned runtime, use Systems Manager, and write temporary objects to the
deployment's upload bucket. The browser user should not receive broad AWS access
just to migrate files.

## Recommended way

Start Codex from the root of this repository so it discovers the repo skill, then
ask:

```text
Use $migrate-agent-configs to move my local Codex and Claude Code settings to my
assigned AgentFormation runtime. Start with a read-only inventory. Do not copy
credentials or session history until I approve those categories separately.
```

The skill is stored at
[`../.agents/skills/migrate-agent-configs/SKILL.md`](../.agents/skills/migrate-agent-configs/SKILL.md).
It verifies the exact user-to-instance assignment, stages only encrypted data,
uses AWS Systems Manager to perform the remote work, validates both tools, and
removes the temporary local, S3, and remote files.

## Inventory everything before moving anything

Treat these as separate choices. The inventory should compare local and remote
names, sizes, versions, hashes, and database row counts without printing file
contents or secret values:

| Category              | Typical contents                                                                                                                                                 | Default                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Codex settings        | `config.toml`, status line, model and approval preferences, global `AGENTS.md`, rules, hooks, personal skills, intentional plugins, and portable MCP definitions | Review and migrate                                            |
| Codex history         | `sessions/`, `archived_sessions/`, prompt history, session names, thread indexes, memories, and goals                                                            | Ask first; it may contain sensitive work                      |
| Claude Code settings  | `settings.json`, user instructions, hooks, skills, and portable MCP definitions                                                                                  | Review and migrate                                            |
| Claude Code history   | approved project and conversation history                                                                                                                        | Ask first; it may contain sensitive work                      |
| Codex ChatGPT login   | `~/.codex/auth.json` when file-based login is enabled                                                                                                            | Do not copy unless the person wants OpenAI instead of Bedrock |
| Claude login          | Claude account or operating-system credential state                                                                                                              | Prefer a fresh supported login; Bedrock needs none            |
| MCP and GitHub logins | OAuth tokens, keychain records, or CLI credentials                                                                                                               | Prefer fresh device/OAuth login on the runtime                |
| Source repositories   | committed code and optional uncommitted work                                                                                                                     | Prefer a fresh clone; ask separately about uncommitted files  |
| Disposable state      | logs, caches, sockets, locks, temporary files, process state, downloaded runtimes, and compiled plugin binaries                                                  | Do not copy                                                   |

Do not mistake a matching directory size for a completed migration. Check each
portable category, preserve newer remote-only files, and verify the behavior the
person expects after installation. For example, confirm the status line from the
remote config and prove that one approved old thread is both present and indexed.

The public AgentFormation defaults do not need personal OpenAI or Anthropic
credentials. Codex and Claude Code use the EC2 runtime's AWS role to call Bedrock.
Changing one runtime to a personal provider is possible, but it is a deliberate
per-user override and should not change the public template.

## How the protected transfer works

Systems Manager provides the authenticated remote channel, but AWS warns against
putting secrets directly in Run Command parameters because command history is
retained. The migration therefore uses this pattern:

```text
approved local files
        |
        v
allowlisted archive -- client-side encryption --> encrypted S3 objects
                                                       |
                                    assigned runtime reads only its prefix
                                                       |
                                                       v
SSM command --> verify, decrypt in private temp dir, install, validate, clean up
```

The destination creates a one-time key pair and keeps its private key on the
runtime. The source encrypts the archive and wraps its random archive secret with
the destination's public key. Only ciphertext is uploaded. After validation, the
operator deletes the exact S3 objects and both machines delete their temporary
key and archive files.

Remote files are backed up before replacement. Credential files are owned by the
`agentformation` user, readable only by that user, and never committed to this
repository.

## Portability checks

- Rewrite paths such as `/Users/name/...` to Linux paths under
  `/home/agentformation` or `/workspace`.
- Disable local-only MCP servers and tools instead of marking them required and
  preventing the CLI from starting.
- Keep Linux-installed system skills and plugin packages when the runtime uses a
  newer Codex version. Move the person's selections and portable custom content,
  not a macOS plugin cache or bundled binary.
- Merge session files and line-oriented history when the runtime already has new
  chats. Do not replace the remote history database with an older local copy.
- Do not copy macOS Keychain data, sockets, process state, caches, logs,
  `node_modules`, virtual environments, or machine-specific binaries.
- Back up live SQLite databases with SQLite's backup operation before archiving
  them.
- On macOS, create the archive with Apple metadata disabled. Reject AppleDouble
  files such as `._payload`, absolute paths, parent-directory paths, symlinks,
  and every entry outside the approved allowlist before extraction.
- Preserve the original Bedrock config whenever a user intentionally switches a
  runtime to a personal OpenAI or Anthropic login.

## Find migrated Codex chats

Codex filters its normal resume picker to chats whose indexed working folder
matches the current folder. Local chats commonly record a path such as
`/Users/name/project`, while AgentFormation starts in `/workspace`. Copying the
chat files without adapting that index makes a migration look successful while
ordinary `codex resume` and the in-app `/resume` command show no chats.

When approved history is installed, keep an SQLite backup. Map each copied
rollout path from the source Codex `sessions/` or `archived_sessions/` directory
to its matching directory beneath `/home/agentformation/.codex/`, and map copied,
unarchived user-chat working folders to `/workspace`. Verify that every indexed
rollout is a regular file beneath one of those remote directories. Do not rewrite
message content. Keep the original paths in the encrypted transfer manifest or
restricted rollback copy, and set this portable runtime preference:

```toml
[tui]
resume_cwd = "current"
```

Then verify the ordinary picker first:

```bash
codex resume -C /workspace
```

It must show the migrated interactive chats. Also verify the wider picker:

```bash
codex resume --all --include-non-interactive -C /workspace
```

`--all` disables the folder filter, `--include-non-interactive` requests chats
created by non-interactive Codex commands, and `-C /workspace` gives the resumed
chat a real Linux folder. Finally, resume one approved migrated chat directly by
its ID. File counts alone are not proof that the picker or the chat can read it.
A configured status line appears after Codex enters a conversation; it is not
shown on every startup or trust screen.

## Remote OAuth callbacks

Some MCP clients open a browser and then redirect to a URL beginning with
`http://127.0.0.1:<port>/callback` or
`http://localhost:<port>/callback`. In a remote browser terminal, that address
belongs to the private runtime, not the laptop running the browser.

The browser will normally show `ERR_CONNECTION_REFUSED`; that is expected because
its `127.0.0.1` is the user's device rather than the remote runtime. Copy the
complete URL from the failed page's address bar, return to the still-open
AgentFormation tab, choose **Finish login**, and paste it into **Complete remote
login** while the CLI is still waiting. AgentFormation validates that the
destination is strictly local and sends the one-time callback only to the
signed-in person's assigned runtime.

See the [remote CLI sign-in guide](remote-cli-login.md) for the complete user
flow, safe handling rules, and troubleshooting steps.

## Validate and revoke

After migration:

1. Compare the remote status line, global instructions, hooks, rules, personal
   skills, plugin selections, and MCP names with the approved local inventory.
2. Confirm `codex login status` shows the intended provider or login method.
3. Confirm `codex mcp list` succeeds and required MCP servers do not block Codex
   startup.
4. Run `codex resume -C /workspace`, confirm migrated interactive chats appear,
   then run `codex resume --all --include-non-interactive -C /workspace` and
   directly resume one approved old session by ID when history was migrated.
5. Start Claude Code and use `/status` to confirm its settings and provider.
6. Confirm newer remote-only chats remain present and the rollback directory is
   private and readable only by the runtime user.
7. Confirm the exact temporary S3 prefix and local and remote scratch directories
   are empty or gone.

Do not report the migration complete merely because files were uploaded. Report
it only after the remote behavior, retained remote-only state, rollback copy, and
cleanup checks all pass.

Run `codex logout` or the provider's normal revocation flow on the remote runtime
to remove a copied personal Codex login. Logging out on the source computer does
not delete a separate remote credential cache.

For current vendor details, see the official
[Codex authentication guide](https://learn.chatgpt.com/docs/auth),
[Codex skill guide](https://learn.chatgpt.com/docs/build-skills),
[Claude Code settings guide](https://code.claude.com/docs/en/settings), and
[AWS warning about secrets in Run Command](https://docs.aws.amazon.com/systems-manager/latest/userguide/running-commands.html).
