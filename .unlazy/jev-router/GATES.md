# Jev router root gates

OWNS: .unlazy/jev-router/**

- [ ] G1: Main and task controls route independently through the extension.
  CHECK: bun test test/extension.test.ts
  EXPECT: EXTENSION_GATES_PASSED
  CWD: /Users/dan/code/omp-jev-router
  EVIDENCE: pending

- [ ] G2: Quota semantics cover account OR and window AND, stale, reset and cancellation behaviour.
  CHECK: bun test test/quota.test.ts
  EXPECT: QUOTA_GATES_PASSED
  CWD: /Users/dan/code/omp-jev-router
  EVIDENCE: pending

- [ ] G3: Jev classification and candidate policy preserve capability floors and bounded failures.
  CHECK: bun test test/router.test.ts
  EXPECT: ROUTER_GATES_PASSED
  CWD: /Users/dan/code/omp-jev-router
  EVIDENCE: pending

- [ ] G4: Typecheck and actual OMP lifecycle smoke prove first-dispatch routing and preservation of child settings.
  CHECK: bun run typecheck && bun run smoke
  EXPECT: SMOKE_GATES_PASSED
  CWD: /Users/dan/code/omp-jev-router
  EVIDENCE: pending

- [ ] G5: Status and commands expose live quota age, reset and eligibility without secrets.
  CHECK: bun run smoke
  EXPECT: STATUS_GATES_PASSED
  CWD: /Users/dan/code/omp-jev-router
  EVIDENCE: pending

- [ ] G6: Fresh independent review accepts quota, lifecycle, credentials and pin preservation.
  EVIDENCE: pending

- [ ] G7: Documentation records controls, candidate configuration, privacy and usage-limit semantics.
  EVIDENCE: pending
