---
name: tmux
description: Run non-trival CLI applications using tmux. Use when you need to run, interact with, or verify behavior of terminal programs that require user input, produce dynamic output, run persistently or if you don't know how they will behave (e.g. REPLs, TUI apps, servers, prompts).
---

# Testing Interactive CLI Apps with tmux

When testing interactive CLI applications, use tmux to run them in a detached session. This lets you send input, read output, and verify behavior without blocking the agent.

## Start an Interactive App

```bash
tmux new-session -d -s testing
tmux new-window -t testing -n shell 'bash'
tmux send-keys -t testing:shell "<interactive command>" C-m
```

You know how to figure the rest out yourself.

## Tips

- Always kill sessions when done to avoid leaking processes
- Use unique session names if running multiple apps in parallel.
- Using an interactive shell as the first command allows you to keep the window open when the command crashes or exits unexpectedly.
