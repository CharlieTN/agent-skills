# Run telemetry — where one review's wall clock goes

A review's wall time is roughly its number of model turns times the time one turn takes.
A/B rounds 3–9 on sync-tray#72 measured 13–16 seconds per turn, but only four coarse phases per run — setup, finders, verification, finalize — so no single step's cost was ever known.
This rule gives every run a per-step breakdown, and exports it as a trace in the shape Dash0's AI Coding Insights reads.
[`review-telemetry.mjs`](../scripts/review-telemetry.mjs) is the executable form.

## What is recorded without you

| Step | Recorded by | When |
| --- | --- | --- |
| `prepare` | `prepare-review.mjs` | Starts the run; backdated to the script's own start. Each internal phase (`fetch`, `resolve`, `workspace`, `classify-shape`, `impact-graph`, `packet`, `standards`, `triage-routing`) is a child span with its own start and end. |
| `finalize` | `finalize.mjs` | Adds the outcome (verdict, candidates, confirmed, posted inline) to the run; **finishes and exports the run under `--dry-run`** when it renders. A finalize that fails to render is an ERROR step and leaves the run open, so the re-run that succeeds is the one exported. |
| `post` | `execute-write-plan.mjs` | A real run's last step; finishes and exports the run. |

The ledger is `telemetry.jsonl` next to `context.json` — `context.telemetry.runDir`.
Bind it once, right after `prepare-review.mjs` wrote the context:

```bash
RUN_DIR="$(jq -r '.telemetry.runDir' ctx.json)"
TELEMETRY="$AGENT_SUPPORT/pr-reviewer/scripts/review-telemetry.mjs"
```

`prepare-review.mjs --no-telemetry` starts no run; the hybrid intent worker uses it, because its preparation is part of the reviewer's run, not a run of its own.

## What you mark: the model steps

Everything between `prepare` and `finalize` is model time, and only you know where one step ends and the next begins.
Mark a step when it starts; a step ends when the next one starts.
A gap nobody marked is exported as `unmarked`, so the steps always add up to the run.

| Step | Starts at |
| --- | --- |
| `memory` | Step 0.7 / Step 1.0 memory reads |
| `gates` | Step 1.8 |
| `finders` | Phase D, the first finder |
| `intent-wait` | hybrid only: waiting for `--intent-from` |
| `lenses` | Step 2.4, the holistic broad pass |
| `consolidate` | Step 2.5 |
| `verify` | Step 2.6b |
| `judgments` | writing `judgments.json` |
| `state` | Step 4c / 4d memory writes |

**Never spend a tool call on a marker.**
A turn costs 13–16 seconds; ten markers issued on their own would add two minutes to the run they measure.
Put the marker in front of the step's first real command, joined with `;`.
A marker always exits 0 — a misuse is a stderr warning — so it can never stop the command after it.

```bash
# correct: the marker rides on the command the step needed anyway
node "$TELEMETRY" step verify --run-dir "$RUN_DIR"; rg -n "pendingCount" "$WORKDIR"

# incorrect: a turn spent on the marker alone
node "$TELEMETRY" step verify --run-dir "$RUN_DIR"
```

Attach a count to the open step with `--attr`, for example `--attr candidates=14` on `verify`.
Keys are prefixed `pr_review.` automatically, so a marker can never overwrite a `gen_ai.*` or VCS attribute.

**Sub-agents.**
In the hybrid default, fold the intent worker in when you read its file, on the same command:

```bash
INTENT_FROM="/the/path/passed/as/--intent-from/intent.json"
node "$TELEMETRY" worker intent import --from "$(dirname "$INTENT_FROM")" --done "$INTENT_FROM" --run-dir "$RUN_DIR"; cat "$INTENT_FROM"
```

**Stopping early.**
If you stop before a finalize succeeds, finish the run on your last command so the failure is exported rather than left in the ledger:

```bash
node "$TELEMETRY" finish --status error --message "<why the run stopped>" --run-dir "$RUN_DIR"
```

A finalize re-run after one that already exported is not added to the trace; the summary line says so.

Under `--fanout`, the orchestrator marks each unit around its message: `worker <unit> start` for every unit before the message, `worker <unit> end` after it returns — one command each side, never one per unit.

## Exporting to Dash0

Export is opt-in.
Set `PR_REVIEWER_OTLP_ENDPOINT` and `PR_REVIEWER_OTLP_HEADERS`, or set `PR_REVIEWER_TELEMETRY=on` to reuse the standard `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS`.
A host's own `OTEL_*` variables are never picked up silently: an Agent0 sandbox sets them for its own process telemetry, and a review trace carries repository names, PR URLs, and a git user name.
`PR_REVIEWER_TELEMETRY=off` wins over everything.
The summary — `telemetry-summary.json`, and a table on stderr — is written whether or not anything is exported.

```text
PR_REVIEWER_OTLP_ENDPOINT=https://ingress.eu-west-1.aws.dash0.com
PR_REVIEWER_OTLP_HEADERS=Authorization=Bearer <token>,Dash0-Dataset=default
```

### The trace

It follows the [OpenTelemetry GenAI conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) as Dash0 reads them for coding agents ([span attributes](https://dash0.com/docs/dash0/darkplane/insights/span-attributes)), and the attribute contract of the [Dash0 agent plugin](https://github.com/dash0hq/dash0-agent-plugin):

| Span | Attributes |
| --- | --- |
| `invoke_agent pr-reviewer` (root) | `gen_ai.operation.name=invoke_agent`, `gen_ai.agent.id=<run id>`, `gen_ai.conversation.name=pr-reviewer <owner>/<repo>#<n>` (only when the run is not joined to a harness session), the outcome under `pr_review.*` |
| `pr_review.step <name>` | `pr_review.step.name`, `pr_review.step.kind` (`script` · `model` · `dispatch`), `pr_review.step.marked`; ERROR with `error.type=step_failed` when the step failed |
| `pr_review.phase <name>` | child of a script step: `pr_review.step.name`, `pr_review.phase.name` |
| `pr_review.worker <unit>` | `pr_review.worker.unit` |
| every span | `gen_ai.agent.name`, `gen_ai.conversation.id`, `dash0.gen_ai.vcs.*` (repository, owner, PR URL, head ref and revision), `user.name` |

Two histograms carry the numbers across runs: `pr_review.step.duration` (by step and kind) and `pr_review.run.duration` (by tier, topology, and verdict).
Neither carries a run id, a PR number, or a user, so their cardinality stays flat.

Three things the trace never contains:

1. **No `chat` span and no token counts.** The harness owns model usage — the Dash0 agent plugin reads it from the transcript — and a script cannot see it.
2. **No `execute_tool` span.** The plugin already emits one per tool call; a second copy would double every tool-call count.
3. **No `gen_ai.harness.name` inside a harness the plugin covers** (`claude-code`, `cursor`, `codex`, `github-copilot-cli`) unless the run is joined to that harness's session.
   Otherwise every review would appear as a second, zero-cost coding session next to the one the plugin already recorded.
   Join it by setting `PR_REVIEWER_CONVERSATION_ID` to the harness session id; the run then lands inside that session.
   A harness the plugin does not cover — `agent0`, a CI runner through `PR_REVIEWER_HARNESS` — is always named.

`PR_REVIEWER_OMIT_USER_INFO=true` drops `user.name`; `PR_REVIEWER_TEAM_NAME` sets `dash0.team.name`.

### Proof

`review-telemetry.mjs --self-test` builds a run from a synthetic ledger and asserts the tree, the contract, the harness rule, and an export into a real local OTLP receiver.
The `pr-reviewer · telemetry smoke` workflow exports one synthetic run to Dash0 whenever the telemetry code changes, with `pr_review.smoke=true`, and fails if the export did not succeed.
It ships as [`templates/review-telemetry-smoke.workflow.yml`](../templates/review-telemetry-smoke.workflow.yml); copy it to `.github/workflows/` to turn it on.
