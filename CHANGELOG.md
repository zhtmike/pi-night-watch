# Changelog

## 0.1.0 — core loop

Initial release. Worker/reviewer loop: full-capability headless pi
rounds, fresh-context reviewer verdicts parsed as schema-validated tool calls from
event streams (one repair retry), driver-run criteria as a PASS precondition,
criteria-file tamper guard, crash recovery by stateless re-derivation (write-ahead,
inspect — never blind replay), deadline leash over process groups, stagnation halt on
identical failure signatures, single-flight advance, per-role model/thinking config,
optional `--review` rubric. No daemon, no runtime dependencies; 67 free unit checks
across 9 suites. Verified by observed runs: DONE happy path, kill -9 crash recovery
with no duplicate spawn, mid-round stop, tamper-probe (guard held).
