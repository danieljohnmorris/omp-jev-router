# Leaf C extension

OWNS: src/index.ts, src/config.ts, src/credentials.ts, test/extension.test.ts

- [ ] C1: Global config parsing and atomic command updates preserve unrelated settings and independent controls.
  CHECK: bun test test/extension.test.ts
  EXPECT: EXTENSION_GATES_PASSED
  CWD: /Users/dan/code/omp-jev-router
  EVIDENCE: pending

- [ ] C2: Main routes before new prompts and tasks route initial children without altering tools, schemas or pinned identities.
  CHECK: bun test test/extension.test.ts
  EXPECT: EXTENSION_GATES_PASSED
  CWD: /Users/dan/code/omp-jev-router
  EVIDENCE: pending
