# Design

Positioning, contracts' rationale, and boundaries. The full surface reference is [api.md](api.md).

## Positioning

pi sessions and their dispatch lanes are fire-and-forget: a lane takes a brief, returns an artifact, and nothing iterates on a verdict. Long-horizon work — where a round of changes must be independently verified, rejected findings disposed of, and the next round seeded from the last — has no owner in that model. pi-night-watch fills exactly that slot and nothing else: the loop, the gate, and the files. It composes with, and does not replace, lane dispatch: worker children are ordinary headless pi processes and inherit whatever the host loads (a worker may fan out through any dispatch tool the user has installed; depth control stays with that tool). A task carries its goal verbatim into every round brief — approvals, constraints, and scope live in the goal text, and anything beyond it is a report item, never auto-executed. Round briefs carry state only, never methodology: instructions and working style ride the goal text and the ambient skills, and the tools' descriptions state their own contracts.

## Pillars

1. **File state only** — the manifest is the single stored truth; outcomes are decided once and immutable; everything else is derived from manifest + events + pids. No database, no server, no daemon.
2. **Stateless advance** — no process is authoritative. Any session or scheduled kicker advances the loop; a killed advance costs nothing durable.
3. **Verdicts are tool calls** — the reviewer's judgment enters the system as a schema-validated structured call parsed from the event stream, never as parsed prose.
4. **The reviewer is a gate, not a security boundary** — it gates quality with fresh context; the worker has full bash by design and is trusted with it.
5. **Caps in code, not prompts** — deadlines, budgets, and stagnation rules are enforced by the driver; the model is never asked to police itself.

## Non-goals

No daemon or authoritative process. No auto-merge: terminal state is DONE → human review; the loop never merges or pushes to protected refs. Not a sandbox or a defense against a hostile worker. No webhook/network listener; external waits are parked and re-checked by any advance or a scheduled kicker (laptop sleep = waits pause; the next fire catches up). No queue, fleet, or personas — two prompts, worker and reviewer. No auto-arm from cloned repos: tasks start only by explicit local action. POSIX only (process groups, `ps -o lstart=`, GNU `timeout`).

## Failure-mode matrix

| Failure | Defense |
|---|---|
| Worker/reviewer hang (stuck bash, retry storm) | `timeout -k` wrapper-parent leash — holds with every night-watch process dead; group TERM→KILL |
| Worker killed / OOM / reboot | write-ahead PENDING + lstart-verified dead pid + no settle ⇒ CRASHED; next round seeded from the events tail — inspect, never replay; loss ≤ one round |
| Advance killed | stateless one-shot; any session re-runs it; single-flight lock prevents double-spawn |
| TUI killed | children are detached groups; the TUI is a viewer |
| Mid-effect crash (side effect done, manifest not yet written) | bounded, not prevented: wake-time inspection + marker-string dedup in briefs; worst case one duplicate external post, visible at the human gate |
| Runaway spend | round leash + maxRounds + stagnation halt; usage/cost ride `message_update` events, spend cap derivable later |
| Torn writes | atomic manifest writes; newline-terminated append-only events; torn tail skipped |

## Why not pi-durable today, and when that flips

1. Durable hosts have their own registry — no skills loader, no inheritance of the TUI's MCP configuration; a durable-native worker would be hobbled.
2. The package is Experimental, with breaking changes inside recent minors.
3. The parts this design would run on — signals, parked tools, onYield reviews — are an unbuilt design draft; a durable daemon today can only wait in-memory or poll: no better than the stateless advance.
4. Round granularity suffices: file-based write-ahead + re-derivation bounds crash loss to ≤ one round.

Adopt when suspendable-work ships **and** stabilizes: swap the advance internals and spawn core (the replaceable part) for `Harness.signal()` wake and parked waits without touching the verdict contract, file layout, state machine, or command surface. Revisit early if mid-turn crash resume or exactly-once external effects become hard requirements.

## Compatibility posture

What can break: children ride pi's CLI surface (`--mode json --no-session --approve -e --model --thinking`) and its JSON event stream — both have changed within pi's 1.x line before. After any pi upgrade, check `pi --help` against the argv builder in `driver.ts` and the event types in `events.ts`. Node ≥ 22.19 (type stripping). macOS needs GNU coreutils for the leash (`timeoutBin: "gtimeout"`).

## Roadmap

1. Core loop (shipped): spawn core, manifest/verdicts, `/watch`, `review_gate`, state machine, caps.
2. Waits + scheduled advance (shipped): `wait {check_cmd, due_at}` verdict field ⇒ WAITING; the `night-watch` kicker bin; retry-in-place with backoff.
3. Unattended decision escalation: the reviewer as decision authority when a worker would otherwise stop and ask.
4. Inspector + events: statusbar live round, `/watch` overlay (verdict chain, events tail), `onEventCmd` on terminal states.

Unscheduled: worker session continuity (`--session-id`); reviewer calibration harness.
