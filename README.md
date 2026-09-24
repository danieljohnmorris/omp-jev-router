# omp-jev-router

An OMP extension that picks the model for a turn, and the agent for delegated
tasks, from two inputs: a Jev capability classification of the prompt, and the
provider usage limits OMP already tracks.

Two switches, independently controlled:

- `main` routes this session's own model, on `before_agent_start`.
- `tasks` routes subagents spawned through the `task` tool, on `tool_call`.

## How a turn is routed

1. The prompt (truncated to `maxPromptChars`) goes to TypeSafe's System One
   endpoint as a single `choice` question over `quick`, `balanced`, `strong`.
   The answer is a capability *floor*, not an exact tier.
2. Usage reports are fetched through OMP's own `AuthStorage.fetchUsageReports`
   and cached for `quotaMaxAgeMs`. Every window of every account for the
   candidate's provider is evaluated: windows are AND (an exhausted weekly
   window blocks a model even with a full 5-hour window), accounts are OR (one
   account with headroom keeps the provider usable, because OMP's own
   credential selection decides which account serves the request).
3. Candidates below the floor, out of quota, or too small for the current
   context plus `contextReserveTokens` are dropped. Among the rest the lowest
   quota pressure wins; ties prefer the cheaper tier, and the current model is
   kept when its headroom is comparable, so a turn does not churn models and
   lose provider cache reuse.

Anything that fails, times out, or returns low confidence falls back to
`strong`, and a failure to route never blocks the turn. If no candidate is
eligible, the session model is left untouched.

## Configuration

`~/.omp/jev-router.json`. With no file, routing is off and nothing happens.
See `jev-router.example.json`.

```json
{
  "main": "auto",
  "tasks": "auto",
  "candidates": [
    { "model": "anthropic/claude-haiku-4-5", "tier": "quick" },
    { "model": "anthropic/claude-sonnet-5", "tier": "balanced" },
    { "model": "anthropic/claude-opus-4-5", "tier": "strong", "thinking": "high" }
  ],
  "taskAgents": { "quick": "sonic", "balanced": "task", "strong": "task" }
}
```

`candidates` is optional. When it is absent or empty, the router derives
candidates from the models this OMP install is logged in to (`ctx.models.list()`,
the same set `--model` offers). Derivation bands each model by output price
(<= $2/M = quick, <= $15/M = balanced, above = strong), requires reasoning
support above `quick`, drops dated snapshot ids and `:batch` routes, then keeps
the most expensive model per provider per tier, at most `cataloguePerTier`
(default 3) providers per tier. Price is a rough capability proxy, so name
`candidates` yourself when you care which models run. `/jev` reports which
source is in use.

Other keys: `cataloguePerTier`, `timeoutMs`, `quotaTimeoutMs`, `quotaMaxAgeMs`,
`confidenceThreshold`, `maxPromptChars`, `contextReserveTokens`.

The Jev API key is read from macOS Keychain (`omp-jev-router` / `dan`) or
`TYPESAFE_API_KEY`. It is never written to the repo or to config.

## Task routing

A `task` item that already names an agent is left alone, so nategpt workers,
reviewers and scouts stay pinned. An item with no agent (or `task`) is
classified and gets the agent mapped to its tier. Task routing selects an
agent, not a model, because the `task` tool schema has no per-item model field;
the agent's own model definition then applies, and quota filtering does not
reach it.

## Commands

`/jev` shows state. `/jev main off`, `/jev tasks auto`, `/jev reload`. Status
and notifications are interactive-only; in print mode the extension routes
silently.

## Install

```
omp -e ~/code/omp-jev-router/src/index.ts
```

or add the directory to `extensions` in OMP settings.

## Tests

`bun test` covers quota window/account resolution and candidate selection.
`bun run typecheck` for types. Vitest does not work here: the OMP packages
need the Bun runtime.
