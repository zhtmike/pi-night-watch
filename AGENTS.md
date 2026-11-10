# pi-night-watch — contributor contract

docs/design.md is the design authority; docs/api.md is the surface reference. Keep README, docs/, and behavior in sync in the same change.

## Modules

| Module | Owns | Purity |
|---|---|---|
| `config.ts` | every tunable: schema, defaults, validation | pure |
| `args.ts` | `/watch start` argument parsing | pure |
| `manifest.ts` | stored-state contract: paths, types, atomic io | fs only |
| `decision.ts` | round-outcome + terminal decisions | pure |
| `briefs.ts` | worker/reviewer brief text | pure |
| `events.ts` | `--mode json` parsing, verdict validation | pure |
| `driver.ts` | orchestration + child argv + liveness guards | node only, no pi imports |
| `index.ts` | the extension (env-gated factory, `/watch`) | only file touching the host |

## Rules

- Every behavior change ships its unit test in the same change when pure; only a live run can cover the rest, and those runs are recorded in CHANGELOG prose — **no model-billing tests in this repo**.
- Fail loudly: no silent fallbacks; unreadable state throws.
- Tunables (binaries, deadlines, graces, timeouts) flow from `config.ts`; schema constants (verdict caps, brief tail, slug limits, reviewer attempts) live beside their contracts as named constants.
- README stays general — no usage scenarios. New surface ⇒ docs/api.md row + docs/design.md update in the same change.
- pi flag drift is the standing compat hazard (children ride `--mode json --no-session --approve -e …`); after any pi upgrade, check `pi --help` against the argv builder in `driver.ts`.
- Comments carry their own invariants — no file cites a design document; no file narrates its own history.
- WHY-comments only, two lines max. The manifest is the only stored state.
- Release: tag-driven; tag == package.json version == a CHANGELOG section.
