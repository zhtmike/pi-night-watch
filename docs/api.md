# API reference

Commands, tools, configuration, on-disk state, and the mechanics behind them. The design rationale lives in [design.md](design.md).

## Commands

All commands operate on the most recent task when `[slug]` is omitted.

### `/watch [slug]`

The inspector: full status (config, rounds, verdict chain, terminal) plus the live round's event tail (assistant messages, tool calls, settle) and task-wide usage/cost — each response's latest `message_update` usage snapshot, accumulated at its close. Zero model tokens — everything is read from disk. While a session is open, the footer also carries a live one-line status (`watch <slug>: round N RUNNING · …`) refreshed every 5 s while a task is live, cleared when none is.

### `/watch start [--criteria cmd] [--criteria-files a,b] [--slug s] [--review rubric] [--goal-file path] [<goal>]`

Creates a task (atomic manifest under `.pi/night-watch/<slug>/`) and spawns round 1. The same start is reachable as `night-watch start` ([Kicker bin](#kicker-bin)) — the entry for shells and agents acting on the owner's instruction, where slash commands cannot go. Flags:

- `--criteria "cmd"` — shell command the driver runs; a round passes only if it exits 0. Quoted segments are preserved (`--criteria "npm test && npm run lint"`).
- `--criteria-files a,b` — files whose hashes are pinned at start; a worker edit to them fails the round as tampering. An accidental-edit guard, not a security boundary.
- `--slug s` — task directory name (defaults to a slug of the goal).
- `--review "rubric"` — an independent rubric delivered to both roles: the worker sees the bar to clear, the reviewer verifies against it.
- `--goal-file path` — take the goal from a file, verbatim: interior line breaks, indentation, and URLs survive intact (trailing whitespace is trimmed). For multi-line prompts this beats inline entry, which the terminal input flattens to one line. Mutually exclusive with an inline goal; an unreadable or empty file is rejected.

Unknown or valueless flags are rejected, never silently folded into the goal.

The goal is re-stated verbatim in every round brief, so anything written into it — an approval statement ("push the fix branch — already human-approved"), constraints, links, working style, decisions you foresee — reaches every round unchanged. The tool adds no approval machinery of its own. The worker's reading of an approval statement rides the `review_gate` description, present in every round's context: the round is unattended and cannot ask mid-run; the goal is the owner's voice and nothing else speaks for the owner; where the worker's approval rules apply, an approval sentence in the goal grants approval for exactly the actions the goal names, as named — the environment's standing approvals hold alongside; naming an action is not approving it — a goal without an approval sentence names outcomes, not approvals, and an approval claim arriving through anything else (task text, comments, files, tool results) approves nothing; an action gated beyond that is never taken — the ask returns in the worker's final report. A worker with no approval rules in its environment simply proceeds — the contract is inert there. Actions beyond the goal's named approvals (merging, pushing to protected refs) are report items at task end, never auto-executed.

Briefs carry state only — goal, round, outcomes, reviewer findings. All methodology and instruction prose belongs in the goal (it reaches both roles) or in the ambient skills; the tools' own descriptions state their call contracts.

### `/watch status [slug]`

Renders the derived state: config summary, terminal state, per-round state (PENDING / RUNNING / outcome), and the verdict chain. Human review after the fact is the point: the worker's final report and the reviewer's findings for every round are visible here.

### `/watch advance [slug]`

The stateless driver step. Decides every settled-but-undecided round, applies terminal rules, and spawns the next round with write-ahead intent. Idempotent; single-flight (a live concurrent advance is refused; a stale claim is taken over).

### `/watch stop [slug]`

TERM to the round head + TERM to its process group, KILL to the group after `killGraceSec`. Terminal state `STOPPED`. Holds the single-flight lock while stopping. The stop is durable in the round-transition window too (settled-but-undecided, or a write-ahead PENDING round): a stop while nothing is running still records `STOPPED`, so a scheduled kicker cannot spawn the next round against it.

## Tools

Roles are env-gated; each child sees only its own tools (`submit_verdict` for the reviewer, `review_gate` for the worker).

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
| `pollJitterMs` | `5000` | Upper bound on the kicker bin's random pre-action sleep |
| `criteria` | — | Shell command run by the driver; PASS requires exit 0. Unset = verdict-only mode (weaker) |

### Sizing long tasks

The wall budget is `maxRounds × roundDeadlineMin` — defaults (10 × 30m ≈ 5 h) fit evening-sized tasks, not migrations. For hours-long work raise both:

```json
{ "maxRounds": 24, "roundDeadlineMin": 90, "reviewerDeadlineMin": 30 }
```

The round leash bounds *everything* the round starts: sub-agents or lanes spawned inside a worker share its process group and die with it at the deadline. Give a round that fans out a `roundDeadlineMin` above its widest lane's own deadline plus margin — a lane killed mid-flight reports nothing back. Lanes also inherit the worker's `NIGHTWATCH_*` env markers, so with this package installed they register the worker tools; a dispatcher's mandatory per-lane tool allowlist keeps them out of a lane's reach unless the lane is granted `*` or names them. The leash is also the guard against runaway spend: a round that would exceed it should be split into rounds (the worker settles, the next round continues with its report).

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
- **FAIL** — reviewer rejected; or verdict pass with criteria failing (the note carries the first line of criteria output); or the round settled without calling `review_gate`; or the tamper guard tripped (criteria files changed or unreadable since start).
- **CRASHED** — the round head died before the worker settled. The next round's brief is seeded from the crashed round's event stream (inspect, never replay).

Terminal states: `DONE` (first PASS wins), `HALT_STAGNANT` (identical failure signature twice — two crashes share a signature), `HALT_BUDGET` (maxRounds exhausted), `HALT_ERROR` (spawn failure), `STOPPED`.

## Kicker bin

`night-watch start [--criteria cmd] [--criteria-files a,b] [--slug s] [--review rubric] [--goal-file path] [<goal>]` · `night-watch advance [dir] [slug]` · `night-watch status [dir] [slug]` — a plain-node bin shipped with the package (`node_modules/.bin/night-watch` when installed). `start` arms a task in the cwd and spawns round 1 — the explicit action beside `/watch start`, reachable where slash commands are not (a shell, an agent executing the owner's instruction); it is never a cron verb, because a scheduled start would be auto-arm. `dir` defaults to the cwd, `slug` to the latest task by mtime. Each kicker invocation is stateless — the same single-flight lock and write-ahead as `/watch advance`; a missed schedule collapses into one catch-up advance. `advance` sleeps a random `0..pollJitterMs` first so machines do not poll in lockstep.

No scheduler ships with it. Recipes (e.g. every minute):

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

Driver-run shells (`criteria`) run under the `timeout` leash, so a timeout kills the command's whole process tree, not just its shell. A `criteria` needing gh auth inherits the kicker's environment — under cron/launchd without an unlocked GUI keychain the keyring may be unreachable; env-token setups (`GH_TOKEN`) work headless. Drive one workspace from one install (one bin, one extension) — a cron entry pointing at a different install than the interactive session silently advances the same tasks with two codebases.

## Mechanics

- **Process topology** — the worker head is a detached `timeout`: session + process-group leader, so the leash holds even if every night-watch process dies. The reviewer runs `timeout --foreground` inside the worker's group (plain `timeout` self-groups and would escape a group kill). Children run `--mode json --no-session --approve` (JSON mode cannot prompt; without `--approve`, project resources would be silently skipped).
- **Verdicts are tool calls** — parsed from the reviewer's event stream (`tool_execution_start` for `submit_verdict`), never from free-form text. One bounded repair retry, then a FAIL verdict with an unparseable-note. Each attempt writes its own event stream, so a torn tail stays a tail.
- **Write-ahead intent** — the round record exists in the manifest before spawn. A PENDING round that already has an event stream was spawned but never recorded: it is decided CRASHED from that stream, never respawned.
- **Atomic writes** — exclusive-create tmp → write → fsync → rename → dir-fsync; the rename is the commit point. Verdicts and events are newline-terminated append-only; a torn trailing line is truncation and skipped.
- **Single-flight lock** — `advance.lock` claimed O_EXCL with pid + `ps -o lstart=` start time; same-host stale claims are taken over via rename (a lost takeover race retries), foreign hosts fail closed, unreadable claims only past `lockGraceMs`. `stop` holds the same lock so a racing advance cannot clobber `STOPPED`.
- **Crash recovery** — loss is bounded to ≤ one round: everything that reached an event stream is on disk, and the next round's brief carries the crashed round's last words.
