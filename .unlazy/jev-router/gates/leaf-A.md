# Leaf A quota

OWNS: src/quota.ts, test/quota.test.ts

- [ ] A1: Quota aggregation implements account OR and applicable-window AND.
  CHECK: bun test test/quota.test.ts
  EXPECT: QUOTA_GATES_PASSED
  CWD: /Users/dan/code/omp-jev-router
  EVIDENCE: pending

- [ ] A2: Stale, missing, model/tier scope, passed reset and native cancellation are covered.
  CHECK: bun test test/quota.test.ts
  EXPECT: QUOTA_GATES_PASSED
  CWD: /Users/dan/code/omp-jev-router
  EVIDENCE: pending
