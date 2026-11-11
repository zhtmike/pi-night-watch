# API reference

Commands, tools, configuration, on-disk state, and the mechanics behind them. The design rationale lives in [design.md](design.md).

## Commands

All commands operate on the most recent task when `[slug]` is omitted.

### `/watch [slug]`

The inspector: full status (config, rounds, verdict chain, decision chain, terminal) plus the live round's event tail (assistant messages, tool calls, settle) and task-wide usage/cost — each response's latest `message_update` usage snapshot, accumulated at its close. Zero model tokens — everything is read from disk. While a session is open, the footer also carries a live one-line status (`watch <slug>: round N RUNNING · …`) refreshed every 5 s while a task is live, cleared when none is.

### `/watch start [--criteria cmd] [--criteria-files a,b] [--slug s] [--review rubric] [--goal-file path] [<goal>]`

Creates a task (atomic manifest under `.pi/night-watch/<slug>/`) and spawns round 1. Flags:

- `--criteria "cmd"` — shell command the driver runs; a round passes only if it exits 0. Quoted segments are preserved (`--criteria "npm test && npm run lint"`).
- `--criteria-files a,b` — files whose hashes are pinned at start; a worker edit to them fails the round as tampering. An accidental-edit guard, not a security boundary.
- `--slug s` — task directory name (defaults to a slug of the goal).
- `--review "rubric"` — an independent rubric delivered to both roles: the worker sees the bar to clear, the reviewer verifies against it.
- `--goal-file path` — take the goal from a file, verbatim: interior line breaks, indentation, and URLs survive intact (trailing whitespace is trimmed). For multi-line prompts this beats inline entry, which the terminal input flattens to one line. Mutually exclusive with an inline goal; an unreadable or empty file is rejected.

Unknown or valueless flags are rejected, never silently folded into the goal.

The goal is re-stated verbatim in every round brief, so anything written into it — an approval statement ("I have already human approved; do it yourself"), constraints, links, working style — reaches every round unchanged. The tool adds no approval machinery of its own: a worker whose environment has approval rules reads them from the goal; a worker with none simply proceeds. Actions beyond the goal's scope (merging, pushing to protected refs) are report items at task end, never auto-executed.

Briefs carry state only — goal, round, outcomes, reviewer findings, decision chain, wait bookkeeping. All methodology and instruction prose belongs in the goal (it reaches both roles) or in the ambient skills; the tools' own descriptions state their call contracts. A goal with an external condition should say so and instruct the worker to gate as soon as its own part is done — the reviewer can then park on it (`wait`), which is far cheaper than a worker polling it into its round leash. A goal that expects mid-flight forks should say the worker escalates them via `consult_reviewer` instead of stalling or picking silently. Consultations are reviewer runs inside the worker's round leash — the leash and `reviewerDeadlineMin` bound them; no separate cap exists.

### `/watch status [slug]`

Renders the derived state: config summary, terminal state, per-round state (PENDING / RUNNING / WAITING / outcome), the verdict chain, and the decision chain (`decision r<n>: <choice> — <question>`, with the worker's recommendation appended when given; `unanswered` when no parseable answer came back). Human review after the fact is the point: every mid-round fork the worker escalated is visible here.

### `/watch advance [slug]`

The stateless driver step. Decides every settled-but-undecided round, applies terminal rules, and spawns the next round with write-ahead intent. Idempotent; single-flight (a live concurrent advance is refused; a stale claim is taken over). A parked round reports `WAITING` with its next check time and spawns nothing.

### `/watch stop [slug]`

TERM to the round head + TERM to its process group, KILL to the group after `killGraceSec`. Terminal state `STOPPED`. Holds the single-flight lock while stopping. A WAITING round has nothing to kill — the stop simply records `STOPPED` and ends the park. The stop is durable in the round-transition window too (settled-but-undecided, or a write-ahead PENDING round): a stop while nothing is running still records `STOPPED`, so a scheduled kicker cannot spawn the next round against it.

## Tools

Roles are env-gated; each child sees only its own tools (`submit_verdict` for the verdict reviewer, `submit_decision` for the decider, `review_gate` + `consult_reviewer` for the worker).

- `review_gate` (worker) — spawns a fresh-context reviewer child, parses its verdict, appends it to the verdict ledger, returns it as the tool result. No arguments.
- `consult_reviewer` (worker) — `{question ≤500, options: ≥2 strings, recommendation?}`: ask the decision authority when facing a fork you would otherwise stop and ask the owner about. Spawns a decision-mode reviewer, appends the ask + answer to the decisions ledger, returns the decision verbatim — interpreting it is the worker's. Never blocks on a human; a run that never calls `submit_decision` is recorded as unanswered and the worker proceeds on its own judgment.
- `submit_verdict` (reviewer) — `passed: boolean`, `notes: string ≤ 500`, `evidence: string[]` (each a command and what it showed), and optionally `wait: {check_cmd ≤ 500 chars, due_at ISO-8601}` — only with `passed:false`, when one external condition outside any worker's control (a CI run, a deploy, a timer) is all that remains. Rejected shapes return an error the reviewer can retry.
- `submit_decision` (decision-mode reviewer) — `choice: string`, `reasoning ≤ 500`; recorded verbatim. Spawned only by `consult_reviewer`; the verdict reviewer never sees it.

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
| `pollJitterMs` | `5000` | Upper bound on the kicker bin's random pre-action sleep |
| `waitRetryBaseMs` | `60000` | First wait-check retry delay; retries back off `2^(n-1)` from here |
| `waitRetryMaxMs` | `900000` | Cap on any single wait-check retry delay |
| `waitMaxAttempts` | `5` | Nonzero checks a parked round tolerates before `wait-exhausted` |
| `criteria` | — | Shell command run by the driver; PASS requires exit 0. Unset = verdict-only mode (weaker) |
| `onEventCmd` | — | Shell command fired when a task reaches a terminal state (`DONE`/`HALT_*` from `advance`, `STOPPED` from `stop`), run at the workspace root with `NIGHTWATCH_SLUG`, `NIGHTWATCH_STATE`, `NIGHTWATCH_DIR` in the environment; bounded by `criteriaTimeoutMs` and runs while the single-flight lock is held. Trust posture identical to `criteria` — it executes on terminal; only configure it in repositories you trust |

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
.pi/night-watch/<slug>/decisions.jsonl            append-only decision consultations (ask + answer)
.pi/night-watch/<slug>/advance.lock               single-flight claim
.pi/night-watch/<slug>/rounds/<n>/brief.md        write-ahead round brief
.pi/night-watch/<slug>/rounds/<n>/worker.events.jsonl   (+ worker.err)
.pi/night-watch/<slug>/rounds/<n>/review-<k>-<a>.events.jsonl   per attempt (+ .err, .brief.md)
.pi/night-watch/<slug>/rounds/<n>/decision-<k>-<a>.events.jsonl  per attempt (+ .err, .brief.md)
```

## Round outcomes and terminal states

A round is decided exactly once, then immutable in the manifest:

- **PASS** ⇔ the last verdict for the round is `passed:true` **and** the criteria command (if configured) exits 0 when run by the driver — or a wait satisfied (below).
- **FAIL** — reviewer rejected; or verdict pass with criteria failing (the note carries the first line of criteria output); or the round settled without calling `review_gate`; or the tamper guard tripped (criteria files changed or unreadable since start); or a wait exhausted / wait satisfied with criteria red.
- **CRASHED** — the round head died before the worker settled. The next round's brief is seeded from the crashed round's event stream (inspect, never replay).

Terminal states: `DONE` (first PASS wins), `HALT_STAGNANT` (identical failure signature twice — two crashes share a signature), `HALT_BUDGET` (maxRounds exhausted), `HALT_ERROR` (spawn failure), `STOPPED`.

## Waits

A rejected verdict may carry `wait {check_cmd, due_at}`: the reviewer attests the goal is met once an external condition holds, and names a shell command that exits 0 when it does. The round then **parks** instead of failing:

- `WAITING` is derived, never stored: round settled + last verdict carries a wait + now before the round's next check time ⇒ `advance` reports WAITING and spawns nothing. `maxRounds` counts worker rounds only — waits and retries never spend one.
- At/after the check time the driver runs `check_cmd` itself (`criteriaTimeoutMs`; the tamper guard applies as in any decide):
  - **exit 0** — the conditional attestation is satisfied: the task's own criteria (if configured) also runs, as for any PASS. Criteria green or none ⇒ `PASS {sig: wait-ok}` — the task may go terminal DONE here, no confirmation round. Criteria red ⇒ `FAIL {sig: wait-criteria-red}` and the next round spawns.
  - **nonzero** — retry in place, never a worker round per poll: the round stays parked and re-checks on a backing-off schedule (`waitRetryBaseMs × 2^(n-1)`, capped at `waitRetryMaxMs`; `waitAttempts`/`waitNextCheckAt` on the round record are the only stored wait state). After `waitMaxAttempts` nonzero checks ⇒ `FAIL {sig: wait-exhausted}`; the next round's brief states the park, the failure count, and the choice: keep waiting with a fresh `due_at`, or change course. Stagnation then applies across rounds as usual.
- The worker sees the park as its gate result (`REJECTED — waiting until <due_at> on <check_cmd>`) and settles; a round parks on at most one wait, and a new wait comes from the next round's reviewer.
- Known weakness: in verdict-only mode (no `criteria`) a satisfied check alone completes the round on a possibly-stale attestation — tasks that park on waits should configure `criteria`.

## Kicker bin

`night-watch advance [dir] [slug]` · `night-watch status [dir] [slug]` — a plain-node bin shipped with the package (`node_modules/.bin/night-watch` when installed). `dir` defaults to the cwd, `slug` to the latest task by mtime. Each invocation is stateless — the same single-flight lock and write-ahead as `/watch advance`; a missed schedule collapses into one catch-up advance. `advance` sleeps a random `0..pollJitterMs` first so machines do not poll in lockstep.

No scheduler ships with it. Recipes, both firing often enough that `waitRetryMaxMs` granularity is respected (e.g. every minute):

```cron
# crontab -e — advance every minute while the machine is up
* * * * * /usr/local/bin/night-watch advance /path/to/repo >> /path/to/repo/.pi/night-watch/kicker.log 2>&1
```

```xml
<!-- ~/Library/LaunchAgents/com.zhtmike.night-watch.plist -->
<plist version="1.0"><dict>
  <key>Label</key><string>com.zhtmike.night-watch</string>
  <key>ProgramArguments</key><array>
    <string>/usr/local/bin/night-watch</string>
    <string>advance</string>
    <string>/path/to/repo</string>
  </array>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
</dict></plist>
```

The check commands run with your user's credentials and environment — only point `check_cmd` at commands you trust, exactly as with `criteria`. Driver-run shells (`criteria`, `check_cmd`, `onEventCmd`) run under the `timeout` leash, so a timeout kills the command's whole process tree, not just its shell. Drive one workspace from one install (one bin, one extension) — a cron entry pointing at a different install than the interactive session silently advances the same tasks with two codebases.

## Mechanics

- **Process topology** — the worker head is a detached `timeout`: session + process-group leader, so the leash holds even if every night-watch process dies. The reviewer runs `timeout --foreground` inside the worker's group (plain `timeout` self-groups and would escape a group kill). Children run `--mode json --no-session --approve` (JSON mode cannot prompt; without `--approve`, project resources would be silently skipped).
- **Verdicts are tool calls** — parsed from the reviewer's event stream (`tool_execution_start` for `submit_verdict`), never from free-form text. One bounded repair retry, then a FAIL verdict with an unparseable-note. Each attempt writes its own event stream, so a torn tail stays a tail.
- **Write-ahead intent** — the round record exists in the manifest before spawn. A PENDING round that already has an event stream was spawned but never recorded: it is decided CRASHED from that stream, never respawned.
- **Atomic writes** — exclusive-create tmp → write → fsync → rename → dir-fsync; the rename is the commit point. Verdicts and events are newline-terminated append-only; a torn trailing line is truncation and skipped.
- **Single-flight lock** — `advance.lock` claimed O_EXCL with pid + `ps -o lstart=` start time; same-host stale claims are taken over via rename (a lost takeover race retries), foreign hosts fail closed, unreadable claims only past `lockGraceMs`. `stop` holds the same lock so a racing advance cannot clobber `STOPPED`.
- **Terminal events** — every terminal write (advance's `DONE`/`HALT_*`, stop's `STOPPED`) goes through one path that fires the configured `onEventCmd` at the workspace root with `NIGHTWATCH_SLUG`/`NIGHTWATCH_STATE`/`NIGHTWATCH_DIR` in the environment; a nonzero exit is surfaced in the advance/stop report, never swallowed.
- **Crash recovery** — loss is bounded to ≤ one round: everything that reached an event stream is on disk, and the next round's brief carries the crashed round's last words.
