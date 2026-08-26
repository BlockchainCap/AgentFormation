# Finish a remote command-line login

Codex, Claude Code, and MCP servers may open a browser to authorize a connection.
Some of those flows finish at a temporary address such as:

```text
http://127.0.0.1:36557/callback/request-id?code=...&state=...
```

The browser will normally show `ERR_CONNECTION_REFUSED`. This is expected. The
browser's `127.0.0.1` means the employee's laptop or phone, while the process
waiting for the callback is inside the private AgentFormation runtime.

## Complete the login

1. Keep the AgentFormation tab open.
2. Start the login from the command-line tool in the remote terminal.
3. Complete the provider's sign-in and approval in the new browser tab.
4. On the `ERR_CONNECTION_REFUSED` page, copy the complete address from the
   browser address bar. Do not copy only the visible error text.
5. Return to the AgentFormation tab and choose **Finish login** in the page
   header.
6. Paste the complete failed address into **Complete remote login**.
7. Choose **Send to runtime** while the command-line tool is still waiting.
8. When AgentFormation reports **Callback delivered**, return to the terminal and
   confirm the tool completed sign-in.

The failed page is part of this flow; AgentFormation does not make the laptop's
localhost listener work. Instead, it safely delivers that one callback from
inside the employee's assigned runtime.

## Handle the address like a password

The callback address contains a short-lived, one-time authorization code:

- paste it only into the signed-in deployment's **Finish login** form;
- do not paste it into chat, tickets, screenshots, shell history, or logs;
- do not reuse an address from an earlier login attempt; and
- close the failed callback tab after AgentFormation delivers it.

AgentFormation accepts only plain HTTP callbacks whose host is exactly
`localhost` or `127.0.0.1`, whose port is numeric, and whose path is `/callback`
or `/callback/<request-id>`. It rejects outside hosts and unsafe paths. The
one-time value is briefly staged under the signed-in subject's encrypted upload
prefix, kept out of Systems Manager command history, and deleted after delivery.

## If it does not finish

- **AgentFormation says Callback delivered, but the CLI is still waiting:** the
  listener probably expired. Cancel that login, start a fresh one, and deliver
  the newly generated address.
- **The form says the callback address is invalid:** copy the complete address
  from the browser address bar, including the port, path, and query string.
- **The form says the runtime command failed:** confirm the runtime is connected,
  keep the CLI waiting, and retry with a fresh login attempt.
- **The browser shows ERR_CONNECTION_REFUSED:** continue with the numbered steps
  above; that browser error by itself is expected.

When asking an administrator for help, share the displayed AgentFormation error
message and approximate time. Do not share the callback address or its `code=`
value.
