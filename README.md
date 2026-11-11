# pi-night-watch

Long-horizon worker/reviewer loop for the
[pi coding agent](https://pi.dev).

A **watch** is a task that outlives your session. Worker rounds are
full-capability headless pi processes — your tools, skills, MCP servers.
When a round believes the goal is met it calls `review_gate`; an
independent fresh-context reviewer returns a schema-validated verdict
parsed from its event stream, never free-form text. A round passes only
if the reviewer passed **and** the driver-run criteria command exited 0.
Failures loop with the reviewer's findings in the next brief; identical
failure signatures twice halt as stagnant; every crash is recovered by
stateless re-derivation from files.

```
watch make-node-test-run-js-ex: Make `node test/run.js` exit 0. …
config: maxRounds=5 deadline=8m criteria=node test/run.js
round 1: CRASHED (round head died before agent_settled)      ← kill -9, mid-round
round 2: PASS (reviewer passed; criteria exit 0)             ← crash-seeded, no duplicate spawn
verdict r2: PASS — src/add.js now correctly returns a + b; test/run.js untouched …
TERMINAL: DONE — round 2 passed
```

## Why

Dispatch lanes are fire-and-forget: a brief in, an artifact out, nothing
iterates on a verdict. Long-horizon work — where changes must be
independently verified, rejected findings disposed of, and the next
round seeded from the last — has no owner in that model. pi-night-watch
takes the same end of the trade as its siblings:

- **No daemon, no process is authoritative** — rounds are detached,
  leashed `timeout` groups that survive everything; the loop advances
  when any session runs `/watch advance`.
- **The filesystem is the whole protocol** — one manifest (atomic
  writes), append-only verdicts, JSONL event streams; outcomes are
  decided once and immutable, everything else is derived.
- **Verdicts are tool calls** — the reviewer's judgment enters as a
  schema-validated structured call; prose is never parsed.
- **The reviewer is a gate, not a security boundary** — the worker has
  full bash by design; criteria *quality* is the real bar, and the
  tamper guard only catches accidental edits.
- **Caps in code, not prompts** — deadlines, budgets, stagnation rules
  are enforced by the driver; the model never polices itself.

Design rationale, failure-mode matrix, and why this does not build on
`pi-durable` today: [docs/design.md](docs/design.md).

## Requirements

- pi ≥ 1.4.0, **macOS or Linux** (POSIX process groups, `ps -o lstart=`, `timeout` — Windows unsupported)
- GNU `timeout`: preinstalled on Linux; on macOS `brew install coreutils` or set `timeoutBin: "gtimeout"` ([configuration](docs/api.md#configuration))

## Install

```bash
pi install npm:@zhtmike/pi-night-watch            # official (registry)
pi install git:github.com/zhtmike/pi-night-watch  # tracks main
pi -e ./src/index.ts                              # try it for one invocation
```

## Quick start

Start a watch with a goal and, ideally, a criteria command the driver
can run itself:

```text
> /watch start --criteria "node test/run.js" --criteria-files test/run.js \
               Make `node test/run.js` exit 0. The bug is in src/add.js.
  task make-node-test-run-js-ex started
  round 1 SPAWNED (head pid 93456)

> /watch status
  round 1: RUNNING pid 93456

> /watch advance        # the stateless driver step — idempotent, single-flight
  round 1: PASS (reviewer passed; criteria exit 0)

> /watch status
  TERMINAL: DONE — round 1 passed
```

The worker calls `review_gate` when it believes it is done; the verdict
comes back through the tool result and lands in the append-only ledger.
The ceremony: *`start` → (`status` \| `advance`)* → terminal state →
human review. `stop` group-kills a live round at any point; a crashed
round is decided from its event stream and the next brief carries its
last words — inspect, never replay.

## API

Five commands, two tools — full parameter, configuration, and mechanics
reference in [docs/api.md](docs/api.md):

- **`/watch`** — the inspector: rounds, the verdict chain, the live round's event tail, task-wide usage/cost; a live footer line while a task runs. Zero model tokens.
- **`/watch start`** — create the task (atomic manifest) and spawn round 1; flags: `--criteria`, `--criteria-files`, `--slug`, `--review` (an independent rubric sent to worker and reviewer alike), `--goal-file` (goal from a file, verbatim — the way to pass multi-line prompts).
- **`/watch status`** — derived state: rounds, verdict chain, terminal.
- **`/watch advance`** — decide settled rounds, apply terminal rules, spawn the next round. Idempotent; single-flight.
- **`/watch stop`** — TERM head + group, KILL after grace; terminal `STOPPED`. Nothing running (settling, or between rounds)? The stop is still recorded — a scheduled kicker can never spawn against it; only an already-determined terminal outcome outranks a stop.
- **`review_gate`** (worker tool) — spawn the fresh-context reviewer, return its verdict.
- **`submit_verdict`** (reviewer tool) — `passed`, `notes`, `evidence[]`. Each child role sees only its own tools.
- **`night-watch` bin** — `advance` / `status` for cron or launchd; same lock, same write-ahead, jittered polls. Unattended rounds advance with no session open.

## State model

Derived on every call from the manifest, event streams, and PID
liveness — round outcomes are stored, phase is never guessed.

| Round | Meaning |
|---|---|
| `PENDING` | recorded (write-ahead), not yet spawned |
| `RUNNING` | head alive by pid + start-time |
| `PASS` | reviewer passed **and** criteria exited 0 (driver-run) |
| `FAIL` | rejected · criteria red · no gate call · tamper guard tripped |
| `CRASHED` | head died before settling; next brief seeded from its events |

Terminal: `DONE` (first PASS wins) · `HALT_STAGNANT` (identical failure
signature twice — two crashes included) · `HALT_BUDGET` (maxRounds) ·
`HALT_ERROR` (spawn failure) · `STOPPED`.

## Configuration

Per-role `workerModel`/`reviewerModel` with separate thinking pins,
binaries, deadlines, graces — every knob in `.pi/night-watch/config.json`;
invalid files fail loudly. Full table:
[docs/api.md](docs/api.md#configuration).

## Testing

`npm test` — free unit suites, one per module concern; no test in this repo bills models.

## Contributing · License

[AGENTS.md](AGENTS.md) · [MIT](LICENSE)
