# Jev router build plan

Scope: jev-router

| Leaf | Owns | Needs | State | Acceptance |
|---|---|---|---|---|
| A quota | src/quota.ts, test/quota.test.ts | src/types.ts | READY | quota OR/AND, stale and reset semantics |
| B engine | src/router.ts, test/router.test.ts | src/types.ts | READY | bounded Jev classification and deterministic policy |
| C extension | src/index.ts, src/config.ts, src/credentials.ts, test/extension.test.ts | src/types.ts | READY | independent main/task controls and lifecycle hooks |
| Integration | package.json, tsconfig.json, README.md, CHANGELOG.md, scripts/smoke.ts, contract repairs | A/B/C verified | WAITING | build, focused tests, actual OMP lifecycle smoke |
| Review | no edits until ownership transfer | integration evidence | WAITING | fresh bulldozer review and fixes |

Concurrent ownership is disjoint. Workers skip formatting, linting, builds and tests. Luna owns integration files and this ledger. Main owns credentials, installation and Linear.
