# superagent

An agent that turns requests from GitHub and Feishu into tickets, and runs each ticket on the coding agent you choose.

- **No web panel.** State is JSON files under `stateDir`, so `ls` and `cat` answer what a dashboard would.
- **No vendor lock-in.** The executor is a configuration value: `claude`, `codex` or `opencode`, behind one interface.
- **No daemon.** Every command is a short-lived process; a cron job or a coding agent can drive it.

## Install

```sh
pnpm install && pnpm build
# put `bin/superagent.js` on PATH, or link it:
ln -sf "$PWD/bin/superagent.js" ~/.local/bin/superagent
```

## Use

```sh
mkdir my-agent && cd my-agent
superagent init             # writes settings.yaml and state/
$EDITOR settings.yaml       # set github.repository, executor.agent, allowed lists
superagent doctor           # confirms the chosen agent is installed
superagent run . -p "Read README.md and summarise it in one sentence."
superagent status
```

`superagent run` is the smallest end-to-end test: it starts the configured agent in the current directory, waits for the
turn to end, and prints the report the agent left in `.superagent/report.json`.

## How a ticket runs

1. A Source receives a message a person addressed to the agent, from an account on the allow list.
2. The engine records a Trigger, assesses it, and either accepts it as a **ticket** or ignores it with a reason.
3. The executor prepares a worktree and starts the configured agent in it with the composed prompt.
4. The agent works, and writes `.superagent/report.json` before it stops.
5. The report is delivered back to the conversation the request came from.

## The agent contract

Every runner satisfies the same three conditions, which is what makes agents interchangeable:

| Condition | Why |
| --- | --- |
| Starts in the ticket's directory | The worktree, not the operator's checkout, is what changes |
| Reads one prompt on stdin, ends the turn | No interactive step a runner must drive |
| Writes `.superagent/report.json` | One file to read, identical for every agent |

Adding an agent is one file in `src/agents/` plus one line in the registry.

## Layout

```
src/core/      domain: triggers, decisions, tickets, assignments, engine
src/state/     file-backed durable state
src/agents/    one runner per coding agent
src/infra/     CLI wrappers, account shims, git configuration
src/settings.ts  the settings schema and a small YAML reader
```

## Status

This is the foundation: the domain, the state layer, the settings file and the agent runners are done and tested. The
GitHub and Feishu pollers and the scheduling loop are the next step; until they land, `superagent run` is how a ticket
is started by hand.

## Tests

```sh
pnpm check                                     # typecheck, unit tests, build
SUPERAGENT_LIVE=1 SUPERAGENT_AGENT=codex pnpm test   # also runs a real agent end to end
```
