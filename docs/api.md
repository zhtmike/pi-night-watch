# API reference

Commands, tools, configuration, on-disk state, and the mechanics behind them. The design rationale lives in [design.md](design.md).

## Commands

All commands operate on the most recent task when `[slug]` is omitted.

### `/watch start [--criteria cmd] [--criteria-files a,b] [--slug s] [--review rubric] [--goal-file path] [<goal>]`

Creates a task (atomic manifest under `.pi/night-watch/<slug>/`) and spawns round 1. Flags:

- `--criteria "cmd"` — shell command the driver runs; a round passes only if it exits 0. Quoted segments are preserved (`--criteria "npm test && npm run lint"`).
- `--criteria-files a,b` — files whose hashes are pinned at start; a worker edit to them fails the round as tampering. An accidental-edit guard, not a security boundary.
- `--slug s` — task directory name (defaults to a slug of the goal).
- `--review "rubric"` — an independent rubric delivered to both roles: the worker sees the bar to clear, the reviewer verifies against it.
- `--goal-file path` — take the goal from a file, verbatim: interior line breaks, indentation, and URLs survive intact (trailing whitespace is trimmed). For multi-line prompts this beats inline entry, which the terminal input flattens to one line. Mutually exclusive with an inline goal; an unreadable or empty file is rejected.

Unknown or valueless flags are rejected, never silently folded into the goal.

The goal is re-stated verbatim in every round brief, so anything written into it — an approval statement ("I have already human approved; do it yourself"), constraints, links — reaches every round unchanged. The tool adds no approval machinery of its own: a worker whose environment has approval rules reads them from the goal; a worker with none simply proceeds. Actions beyond the goal's scope (merging, pushing to protected refs) are report items at task end, never auto-executed.

### `/watch status [slug]`

Renders the derived state: config summary, terminal state, per-round state (PENDING / RUNNING / outcome), and the verdict chain.

### `/watch advance [slug]`

The stateless driver step. Decides every settled-but-undecided round, applies terminal rules, and spawns the next round with write-ahead intent. Idempotent; single-flight (a live concurrent advance is refused; a stale claim is taken over).

### `/watch stop [slug]`

TERM to the round head + TERM to its process group, KILL to the group after `killGraceSec`. Terminal state `STOPPED`. Holds the single-flight lock while stopping.

## Tools

Roles are env-gated; each child sees only its own tool.

- `review_gate` (worker) — spawns a fresh-context reviewer child, parses its verdict, appends it to the verdict ledger, returns it as the tool result. No arguments.
- `submit_verdict` (reviewer) — `passed: boolean`, `notes: string ≤ 500`, `evidence: string[]` (each a command and what it showed). Rejected shapes return an error the reviewer can retry.

## Configuration

`.pi/night-watch/config.json` per project. A config found in a cloned repo never arms anything — starting a task is an explicit local action. Starting a task executes that repo's `criteria` shell string; start tasks only in repositories you trust.

| Key | Default | Meaning |
|---|---|---|
| `workerModel` | pi default | Model for worker rounds; `id:thinking` suffix accepted |
| `workerThinkingLevel` | — | Thinking pin for worker rounds (`off\|minimal\|low\|medium\|high\|xhigh\|max`); wins over the model suffix |
| `reviewerModel` | pi default | Model for the reviewer — prefer a different model family than the worker |
| `reviewerThinkingLevel` | — | Thinking pin for reviewer children; wins over the model suffix |
| `piBin` | `pi` | pi binary for children (resolved on PATH) |
| `timeoutBin` | `timeout` | GNU timeout for the leash (macOS coreutils: `gtimeout`) |
| `maxRounds` | `10` | Round budget; wall budget is derived: `maxRounds × roundDeadlineMin` |
| `roundDeadlineMin` | `30` | Hard leash per worker round |
| `reviewerDeadlineMin` | `15` | Hard leash per reviewer child |
| `killGraceSec` | `10` | TERM→KILL escalation window for the group leash |
| `criteriaTimeoutMs` | `300000` | Timeout for the criteria command |
| `lockGraceMs` | `60000` | Grace before a torn single-flight lock may be taken over |
| `preflightTimeoutMs` | `15000` | Timeout for the child-binary preflight check |
| `criteria` | — | Shell command run by the driver; PASS requires exit 0. Unset = verdict-only mode (weaker) |

### Sizing long tasks

The wall budget is `maxRounds × roundDeadlineMin` — defaults (10 × 30m ≈ 5 h) fit evening-sized tasks, not migrations. For hours-long work raise both:

```json
{ "maxRounds": 24, "roundDeadlineMin": 90, "reviewerDeadlineMin": 30 }
```

The round leash bounds *everything* the round starts: sub-agents or lanes spawned inside a worker share its process group and die with it at the deadline. Give a round that fans out a `roundDeadlineMin` above its widest lane's own deadline plus margin — a lane killed mid-flight reports nothing back. The leash is also the guard against runaway spend: a round that would exceed it should be split into rounds (the worker settles, the next round continues with its report).

## State layout

```
.pi/night-watch/config.json
.pi/night-watch/<slug>/manifest.json              the only stored state (atomic writes)
.pi/night-watch/<slug>/verdicts.jsonl             append-only reviewer verdicts
.pi/night-watch/<slug>/advance.lock               single-flight claim
.pi/night-watch/<slug>/rounds/<n>/brief.md        write-ahead round brief
.pi/night-watch/<slug>/rounds/<n>/worker.events.jsonl   (+ worker.err)
.pi/night-watch/<slug>/rounds/<n>/review-<k>-<a>.events.jsonl   per attempt (+ .err, .brief.md)
```

## Round outcomes and terminal states

A round is decided exactly once, then immutable in the manifest:

- **PASS** ⇔ the last verdict for the round is `passed:true` **and** the criteria command (if configured) exits 0 when run by the driver.
- **FAIL** — reviewer rejected; or verdict pass with criteria failing; or the round settled without calling `review_gate`; or the tamper guard tripped (criteria files changed or unreadable since start).
- **CRASHED** — the round head died before the worker settled. The next round's brief is seeded from the crashed round's event stream (inspect, never replay).

Terminal states: `DONE` (first PASS wins), `HALT_STAGNANT` (identical failure signature twice — two crashes share a signature), `HALT_BUDGET` (maxRounds exhausted), `HALT_ERROR` (spawn failure), `STOPPED`.

## Mechanics

- **Process topology** — the worker head is a detached `timeout`: session + process-group leader, so the leash holds even if every night-watch process dies. The reviewer runs `timeout --foreground` inside the worker's group (plain `timeout` self-groups and would escape a group kill). Children run `--mode json --no-session --approve` (JSON mode cannot prompt; without `--approve`, project resources would be silently skipped).
- **Verdicts are tool calls** — parsed from the reviewer's event stream (`tool_execution_start` for `submit_verdict`), never from free-form text. One bounded repair retry, then a FAIL verdict with an unparseable-note. Each attempt writes its own event stream, so a torn tail stays a tail.
- **Write-ahead intent** — the round record exists in the manifest before spawn. A PENDING round that already has an event stream was spawned but never recorded: it is decided CRASHED from that stream, never respawned.
- **Atomic writes** — exclusive-create tmp → write → fsync → rename → dir-fsync; the rename is the commit point. Verdicts and events are newline-terminated append-only; a torn trailing line is truncation and skipped.
- **Single-flight lock** — `advance.lock` claimed O_EXCL with pid + `ps -o lstart=` start time; same-host stale claims are taken over via rename (a lost takeover race retries), foreign hosts fail closed, unreadable claims only past `lockGraceMs`. `stop` holds the same lock so a racing advance cannot clobber `STOPPED`.
- **Crash recovery** — loss is bounded to ≤ one round: everything that reached an event stream is on disk, and the next round's brief carries the crashed round's last words with a verify-before-acting instruction.
