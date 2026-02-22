---
name: github
description: Run GitHub CLI through a wrapper that manages GitHub App device-code auth and token refresh. Use whenever a task needs gh or GitHub API access via gh.
---

# github

Use this skill for any GitHub operation that would normally call `gh`.

## Rules

- Never run `gh` directly.
- Always run `./gh-app-auth <gh args...>`.
- Keep the real GitHub command visible in a normal foreground call.

## Required environment

- `GH_APP_CLIENT_ID` must be set.
- Optional: `GH_APP_SCOPE`.

If `GH_APP_CLIENT_ID` is missing, ask the user for it.

## Command flow

1. Run the intended command normally:

```bash
./gh-app-auth <gh args...>
```

2. If it exits with code `42`, show the auth message the command printed to the user. The wrapper prints:

- one short instruction line
- the verification URL (next line)
- the user code (next line)

3. Show the URL and code to the user by just showing the verbatim output of the wrapper.

4. Immediately after showing the output, run wait mode without asking for extra confirmation:

```bash
./gh-app-auth --wait-for-auth <gh args...>
```

Do not add extra prompts. Keep user interaction minimal.

Wait mode stays quiet unless an error occurs, then runs `gh` and prints only normal `gh` output.

Optional timeout (default is 900 seconds):

```bash
./gh-app-auth --wait-for-auth --timeout 900 <gh args...>
```

## Exit codes

- `42`: interactive device authorization required
- `43`: wait-for-auth timed out
- `44`: device flow failed (expired/denied/invalid)
