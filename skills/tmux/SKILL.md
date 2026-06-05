---
name: tmux
description: Run non-trival CLI applications using tmux. Use when you need to run, interact with, or verify behavior of terminal programs that require user input, produce dynamic output, run persistently or if you don't know how they will behave (e.g. REPLs, TUI apps, servers, prompts).
---

# Testing interactive CLI apps with tmux

When testing interactive CLI applications, use tmux to run them in a extra session. This lets you send input, read output, and verify behavior without blocking the agent.

## Before starting the app

1. Check if $TMUX is set to determine if there is an active tmux session. If there is, use the existing session. If not, create a new session and output a command the user can run to observe the session.
2. Choose a unique session name if you plan to run multiple apps in parallel to avoid conflicts
3. Run the app in an interactive shell to keep the window open if the app crashes or exits unexpectedly
4. Always kill the session when done to avoid leaking processes

## Start an interactive app

```bash
tmux new-session -d -s testing
tmux new-window -t testing -n shell 'bash'
tmux send-keys -t testing:shell "<interactive command>" C-m
```

You know how to figure the rest out yourself.
