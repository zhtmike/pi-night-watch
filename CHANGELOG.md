# Changelog

## 0.2.0 — unattended: waits, decisions, inspection

A watch now carries long work through the night without a session open,
never stalls at a fork, and shows you everything when you return.

**Waits.** A rejected verdict may carry `wait {check_cmd, due_at}` — the
reviewer attests the goal is met once an external condition holds (a CI
run, a deploy, a timer) and names a command that exits 0 when it does.
The round parks: WAITING is derived, never stored; the driver re-runs
the check itself on a backing-off schedule (`waitRetryBaseMs × 2^(n-1)`,
capped at `waitRetryMaxMs`; retry-in-place never spends a worker round
per poll); a satisfied check decides PASS `wait-ok` outright (DONE
without a confirmation round), exhaustion FAILs `wait-exhausted` with
the park, the count, and the choice in the next round's brief.
`bin/night-watch advance|status` is the stateless kicker for
cron/launchd (jittered, same single-flight lock, same write-ahead);
recipes ship in docs/api.md, no scheduler of our own. Observed run: a
task parked on a gate file, failed its check twice with recorded
backoff (5 s → 10 s), the gate appeared, the next kicker advance
decided PASS → DONE — unattended; a second task exhausted its checks →
FAIL → round-2 brief carried the park sentence verbatim; a kicker
killed -9 mid-run and a stale `advance.lock` both recovered on the next
fire.

**Decisions.** Worker rounds get `consult_reviewer {question, options,
recommendation}`: a fork the worker would otherwise stop and ask the
owner about is escalated to a decision-mode reviewer (`submit_decision
{choice, reasoning}`, one repair retry) and the answer is recorded
verbatim in an append-only `decisions.jsonl` — the ask, the options, the
recommendation, the choice, the reasoning. Interpreting the decision is
the worker's; a run that never answers records an unanswered decision
and the worker proceeds on its own judgment; the chain surfaces in
status and in the next round's brief. Observed run: a two-implementation
goal consulted mid-round, the decider chose "casual", the worker
implemented exactly that, the gate passed — DONE in one round, no
suspension.

**Inspection.** Bare `/watch [slug]` renders the full state (rounds,
verdict + decision chains, terminal), the live round's event tail, and
task-wide usage/cost — each response's latest cumulative
`message_update` usage snapshot, accumulated once at its close (summing
the snapshots themselves overcounts streamed responses). Zero model
tokens. While a session is open, a footer line tracks the live task
(5 s poll, armed at session_start, disarmed at session_shutdown).
`onEventCmd` (optional config) fires on any terminal state — DONE or
HALT_* from advance, STOPPED from stop — at the workspace root with
NIGHTWATCH_SLUG/STATE/DIR in the environment. Observed run: overlay
rendered live mid-round with the real tool tail ending at `review_gate`;
an `onEventCmd` logged `<time> <slug> DONE` via the env vars.

**Start surface.** `--goal-file <path>` carries multi-line prompts
verbatim (interior line breaks, indentation, URLs intact) — approval
statements, constraints, and working instructions ride the goal text
into every round brief. Budgets doc: defaults (10 × 30 min ≈ 5 h) fit
evening tasks; raise both for longer work; the round leash bounds
everything a round starts, lanes included.

**Design contract (owner-set, empirically forced).** The tool adds no
approval machinery — approvals ride the goal text. Round briefs are
pure state sheets: no methodology prose anywhere; instructions ride the
goal and the tool descriptions. Mechanism records, agents judge: no
hardcoded semantic validation — a strict choice∈options matcher built
first was deleted after the observed run rejected two good decider
answers (label vs descriptive option string); deterministic bookkeeping
(outcomes, exit codes, budgets, locks) stays mechanical.

**Readiness table (assessed at owning symbols before the work):**
goal carriage — gap → `--goal-file` (shipped); skill-chain inheritance —
holds by construction (no `-ns`, `--approve` trusts project resources),
the dispatch-lane env-marker wrinkle (lanes inside a worker see the
worker tools) is a known limit, re-verify at first real use; approval —
owner decision, goal text (shipped); budgets — guidance shipped, leash
semantics documented; gh/git auth — resolves by env+HOME inheritance
(code-verified), first real use confirms.

**Verification posture.** Every mechanism above is verified by its own
billed observed run (this entry); the full-chain acceptance run on a
real task of the reference-scenario shape was skipped by owner decision
— this release is ready for real workflow, and the first real task is
its acceptance. Known limits: TUI surfaces (footer/overlay notify) are
load-exercised through the driver builders, not clicked in a live TUI;
the reviewer defaults to the worker's model family unless
`reviewerModel` is configured; the item-4 observed run's usage figures
were displayed by the pre-fix snapshot-summing code and may be
inflated. pi 1.5.0→1.5.1 mid-release: child-argv compat check ran
clean.

**Hardening (post-hunt).** A three-lane defect hunt over the four
features fixed: a lost-spawn-record guard wedge that could dead-watch a
kicker-driven task after one mid-spawn crash; parallel tool-call bursts
on the gate/consult tools (now `executionMode: "sequential"`); driver
shell process trees escaping `criteriaTimeoutMs` (now under the
`timeout` leash, group-killed); stops lost in the round-transition
window (now durable); and 0.1.0's dead criteria-output tail, now wired
into the criteria-red FAIL note. 144 free checks across 10 suites (67/9
at 0.1.0); no test in this repo bills models.

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
