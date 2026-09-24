# omp-jev-router

An [OMP](https://oh-my-pi.dev) extension that picks the model for each turn, and
the agent for each delegated task, from two inputs: a Jev classification of the
prompt, and the provider usage limits OMP already tracks.

A cheap question does not need your most expensive model. A model whose weekly
window is exhausted is not a candidate at all, however capable it is. This
extension applies both facts before the turn starts.

```
$ /jev
main: auto
tasks: auto
credential: loaded
candidates (catalogue): quick=3 balanced=3 strong=3
last main: jev: quick (jev, 0.94) · anthropic/claude-haiku-4-5
last tasks: jev: strong -> task
```

## What it is not

- Not a proxy. No extra process, no request forwarding, no endpoint to run.
  Routing happens inside OMP, before a provider call is made.
- Not a replacement for model roles. A `candidates` entry may name a role alias
  (`@slow`), and the role stays the authority on what that means. Roles answer
  "which model is `slow`"; this answers "which candidate for this turn".
- Not a replacement for `retry.fallbackChains` or an agent's `model:` chain.
  Those react to a failed call. This acts before the call.

## How a turn is routed

1. The prompt, truncated to `maxPromptChars`, goes to TypeSafe's System One
   endpoint as one `choice` question over `quick`, `balanced`, `strong`. The
   answer is a capability **floor**, not an exact tier. Prompts carrying images
   skip the call and take `strong`.
2. Usage reports come from OMP's own `AuthStorage.fetchUsageReports`, cached for
   `quotaMaxAgeMs`. Every window of every account of the candidate's provider is
   evaluated:
   - **Windows are AND.** An exhausted weekly window blocks the model even when
     the 5-hour window is untouched.
   - **Accounts are OR.** One account with headroom keeps the provider usable,
     because OMP's own credential selection decides which account serves the
     request.
   - A window whose reset time has passed is treated as reset. A report older
     than `quotaMaxAgeMs` is reported as stale, not as capacity.
3. Candidates below the floor, out of quota, or with a context window too small
   for the live context plus `contextReserveTokens` are dropped. Among the rest
   the lowest quota pressure wins. Ties prefer the cheaper tier, and the current
   model is kept when its headroom is comparable, so a session does not churn
   models and lose provider cache reuse.

Anything that fails, times out, or returns confidence below
`confidenceThreshold` falls back to `strong`. A routing failure never blocks the
turn. When no candidate is eligible the session model is left untouched.

## Install

```
omp -e ~/code/omp-jev-router/src/index.ts
```

Or add the directory to `extensions` in OMP settings. Requires OMP 18.2 or
later for `ctx.models` and `ctx.setModel`.

The Jev API key is read from `JEV_API_KEY`, `TYPESAFE_API_KEY`, or the macOS
Keychain:

```
security add-generic-password -s omp-jev-router -a "$USER" -w
```

The key is never written to the repo or to the config file.

## Configuration

`~/.omp/jev-router.json`. With no file, routing is off and nothing happens.

```json
{
  "main": "auto",
  "tasks": "auto",
  "candidates": [
    { "model": "anthropic/claude-haiku-4-5", "tier": "quick" },
    { "model": "anthropic/claude-sonnet-5", "tier": "balanced" },
    { "model": "anthropic/claude-opus-4-5", "tier": "strong", "thinking": "high" },
    { "model": "zai/glm-5", "tier": "balanced" }
  ],
  "taskAgents": { "quick": "sonic", "balanced": "task", "strong": "task" }
}
```

| key | default | meaning |
|---|---|---|
| `main` | `off` | Route this session's model on `before_agent_start`. |
| `tasks` | `off` | Route subagents spawned through the `task` tool. |
| `candidates` | `[]` | Models to choose between. Empty derives them from the catalogue. |
| `cataloguePerTier` | `3` | Providers kept per tier when candidates are derived. |
| `taskAgents` | `{}` | Tier to agent name for delegated work. |
| `timeoutMs` | `4000` | Jev classification deadline, capped at 10s. |
| `quotaTimeoutMs` | `4000` | Usage-report fetch deadline. |
| `quotaMaxAgeMs` | `600000` | Age past which a cached report counts as stale. |
| `confidenceThreshold` | `0.6` | Below this, the classification is discarded. |
| `maxPromptChars` | `4000` | Prompt truncation before classification. |
| `contextReserveTokens` | `32000` | Output headroom a candidate must still have. |

`model` accepts `provider/id`, a bare id, or a role alias. `thinking` accepts
`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; omit it to leave the
session's thinking level alone.

### Deriving candidates

With no `candidates`, the router uses the models this install is logged in to,
via `ctx.models.list()`, the same set `--model` offers. Derivation:

- bands by output price: at or below $2/M is `quick`, at or below $15/M is
  `balanced`, above is `strong`
- requires reasoning support above `quick`
- drops dated snapshot ids, `:batch` routes, and image-only models
- keeps the widest context window first, price as tiebreak, so a provider's
  current flagship is preferred over the retired generation it replaced
- keeps at most one model per provider per tier, so a tier spans providers and
  survives one of them running dry

Price is a rough capability proxy. Name `candidates` yourself when you care
which models run. `/jev` reports which source is in use.

## Task routing

A `task` item that already names an agent is left alone, so nategpt workers,
reviewers and scouts stay pinned. An item with no agent, or the default `task`,
is classified and gets the agent mapped to its tier.

Task routing selects an **agent**, not a model, because the `task` tool's item
schema has no per-item model field. The agent's own `model:` frontmatter then
applies, and quota filtering does not reach it. Give a tier an agent whose model
chain you trust.

## Commands

| command | effect |
|---|---|
| `/jev` | Show state, credential, candidate source, last decisions. |
| `/jev on` / `/jev off` | Both switches at once. |
| `/jev main auto` / `/jev main off` | Session routing on or off. |
| `/jev tasks auto` / `/jev tasks off` | Delegated routing on or off. |
| `/jev reload` | Re-read the config file. |

Every switch change is written back to `~/.omp/jev-router.json`, so it holds
across restarts. Other keys in the file are left alone.

Status and notifications are interactive-only. In print mode the extension
routes silently.

## Development

```
bun test
bun run typecheck
```

Tests cover quota window and account resolution, candidate selection, and
catalogue derivation. Vitest does not work here: the OMP packages need the Bun
runtime.
