# Integration

OWNS: package.json, tsconfig.json, README.md, CHANGELOG.md, scripts/smoke.ts

- [ ] I1: All package tests and typecheck pass after integration.
  CHECK: bun test test/quota.test.ts && bun test test/router.test.ts && bun test test/extension.test.ts && bun run typecheck
  EXPECT: INTEGRATION_GATES_PASSED
  CWD: /Users/dan/code/omp-jev-router
  EVIDENCE: pending

- [ ] I2: Actual OMP/SDK lifecycle smoke observes first child dispatch model and preserves pins and settings.
  CHECK: bun run smoke
  EXPECT: SMOKE_GATES_PASSED
  CWD: /Users/dan/code/omp-jev-router
  EVIDENCE: pending

- [ ] I3: Docs describe both modes, quota semantics and privacy.
  EVIDENCE: pending
