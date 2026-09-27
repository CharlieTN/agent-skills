# Dispatch topology (Phase D/E) — driven by the budget, never model discretion

This rule owns *how* the single-dispatch `pr-reviewer` agent itself runs Phase D (finders) and
Phase E (verification) when it holds `Task` for further nested dispatch — a decision the agent body
used to leave to in-the-moment judgment. That freedom was measured, not assumed: an A/B dry run of
two arms reviewing the same PR at the same commit found the arm that ran `intent`, `standards`, and
`quality` in-context missed the best-corroborated bug in the diff, while the arm that ran them as
sub-agents caught it — same rubric, same finders, same verifier, different topology, different
outcome. The fix is to stop treating topology as a free variable.

The variable it now reads from is the **thoroughness budget** —
[`depth-routing.md § Thoroughness budget`](./depth-routing.md#thoroughness-budget) owns the
continuous 0–1 knob and the breakpoints; [`route-depth.mjs`](../scripts/route-depth.mjs)'s
`resolveBudget(i)` is its pure executable form, the same routing-vs-execution split
`depth-routing.md`/`route-depth.mjs` already use for tier selection. This file governs only what a
budget's `topology` field *means in practice* — nothing here hard-codes a tier's topology, because
there is no longer a fixed per-tier table to hard-code: `resolveBudget()` is what decides.

This is **not** a restatement of [`skills/quality/pr-review/SKILL.md`](../../../skills/quality/pr-review/SKILL.md)'s
`--fanout` orchestration, which already prescribes its own Steps c/e explicitly for that opt-in flag.
It governs the *ordinary* single-dispatch review (`/pr-review`, or `Task(subagent_type="pr-reviewer", …)`
with no `--fanout`) on a harness where that one dispatch can itself still hold `Task` and fan out
further. The two independently converge on a similar shape because this file's design follows that
one's precedent by reference, not by copy.

`finders.md` and `finding-verifier.md` stay byte-identical — this file is orchestration, not rubric.
Neither finder candidates nor verifier verdicts change shape; only *how many dispatches produce them,
and in what grouping* is prescribed here.

## The three topologies

`resolveBudget()` returns one of three values in `budget.topology`:

| Topology | When | Sub-agents | Why |
| --- | --- | --- | --- |
| `in-context` | `t < 0.4`, or no dispatch capability | none | A quick review is cheaper than one dispatch's base cost. |
| `hybrid` | **the default at `t ≥ 0.4`** | the intent finder only (`budget.isolatedFinders`) | A/B rounds 7–8 on sync-tray#72: isolated, the intent finder flagged the highest-severity agreed defect in 3 of 3 runs, in 5–6 minutes each; in one context with the other finders, the default setting had missed it in 4 of 4 rounds. |
| `parallel` | `/pr-review --fanout` only (`resolveBudget({ …, fanout: true })`) | every active finder, sharded per file group; lenses; verifier batches | Round 8, the first real fan-out: every known defect raised, but ~57 minutes projected against 9–13 for one context. Thoroughness alone never selects it. |

**Running `hybrid`:**

1. At the start of Phase D, dispatch the intent finder with the worker preamble, the full review
   packet, and an output path.
   Where the dispatch tool can return before the sub-agent finishes (a background option), use it,
   so the intent finder runs while you run the other finders.
   Where it cannot, dispatch it first and wait: the wait is 5–6 minutes on a 22-file PR, and it is
   what made the default catch the top defect.
2. Run every other active finder, every lens, and verification in your own context, exactly as
   `in-context` does — including the orchestrator-as-verifier steps under *Verification* below.
3. Before Step 2.5 consolidation, read the intent finder's output file and add its candidates to
   the pool.
   An intent candidate is verified in your context like any other; it is not trusted because it
   came from a sub-agent.
4. If the dispatch returned no readable output file, retry it once (the queue rules below).
   A second failure is a `RUN_ANOMALY` naming the unit — and the intent finder then runs in-context,
   so the review never loses the finder itself.

**Running `hybrid` when the reviewer holds no dispatch tool.**
`/pr-review` dispatches this agent as a sub-agent, and a sub-agent cannot dispatch another, so on
that path the caller orchestrates the split: it sends this agent and the intent worker in one
message, and passes `--intent-from <path>` naming the file the intent worker writes
([`skills/quality/pr-review/SKILL.md` § Step 2](../../../skills/quality/pr-review/SKILL.md#step-2-dispatch-the-agent)).
With `--intent-from <path>`:

1. Do not run the intent finder in this context.
2. Run every other finder, lens, and gate as usual.
3. Before Step 2.5, read `<path>`.
   If it does not exist yet, wait for it — check every 20 seconds, for at most 10 minutes.
   On the command that reads it, fold the worker into this run's telemetry with
   `review-telemetry.mjs worker intent import --from <dir of path> --done <path>`
   ([`run-telemetry.md`](./run-telemetry.md#what-you-mark-the-model-steps)).
4. If it never appears or does not parse, run the intent finder in this context and add
   `intent worker returned no readable candidates — ran intent in-context` to `RUN_ANOMALY` through
   `context.render.RUN_ANOMALY`.
   The review never loses the finder itself.
5. Verify its candidates here like any others.
   Line numbers from the worker cite its own checkout of the head; a head that moved in between shows
   up as a line-validity failure, never as a trusted finding.

```text
# correct (hybrid, background-capable harness)
dispatch intent (background) → run correctness, consumer-impact, dependency, standards, quality,
lenses in-context → read intent's file → verify every candidate in-context → finalize

# incorrect: waiting on a background intent dispatch before starting the other finders
dispatch intent → wait → run the other finders       # serialises what was meant to overlap
```

## `PR_REVIEW_MAX_PARALLEL`

The concurrency cap for this pipeline is **6** sub-agent dispatches per message.
Never put two candidates from the same **code region** in the same verifier dispatch: the same `path`
and within `REGION_LINES` (40) lines of each other, or naming the same symbol, or either one with no
line.
That is the same rule `skills/quality/pr-review/SKILL.md` Step e states for `--fanout`: batching two
claims about one region together is the shared-summary problem `finders.md`'s independence rule
forbids at the finder stage, moved one step downstream, and it makes the verifier quieter on each
claim instead of adversarial on one.
Two claims 400 lines apart in one file share no code for the verifier to conflate, and the old
path-only key cost round 8 a floor of 33 batches because one file carried 33 candidates.

## Packing — how units become dispatches

A/B round 2 measured wall-clock and tokens as driven by **sub-agent count**: every dispatch pays a
base of roughly 110–160k tokens before it reads a line of the diff, and round 2's arms ran 22
(`t = 0.8`) and 33 (`t = 1.0`) sub-agents.
[`plan-dispatch.mjs`](../scripts/plan-dispatch.mjs) is the executable form of the grouping below;
never group by hand.

| Unit | Dispatches | Why |
| --- | --- | --- |
| each active finder | one each | A/B round 1: the arm that ran `intent`/`standards`/`quality` in one context missed the best-corroborated bug. |
| each shard of a per-file finder (`correctness`, `consumer-impact`, `quality`) | one each, over its own packet part | Round 8: every fan-out worker read the whole 6,600-line packet and took 8–14 minutes. |
| `correctness` votes | **retired — one pass** | Round 8: two votes raised 24 and 25 candidates that dedupe barely merged, at ~10 minutes of one worker each. |
| holistic broad pass, optimality, measurability | **one lens-bundle dispatch** for whichever of the three are active | The three lenses read the same whole-change context and none reads another's output, so separate contexts buy nothing. |
| standards-conformance lens | one, never in the bundle | `SKILL.md` Step c: the lens and the `standards` finder are two separate dispatches. |
| verification | one per batch of at most **`VERIFY_BATCH_MAX` (8)** candidates, no two from one region, at most `VERIFY_CAP` (40) candidates per run | One dispatch per candidate paid the full base for each verdict. |

Plan the verification batches from the deduped candidates, then dispatch one verifier per batch:

```bash
node agents/pr-reviewer/scripts/plan-dispatch.mjs --verifier-batches <deduped-candidates.json>
```

It prints each batch's candidate indexes and paths, the messages to send them in, and any overflow.
It verifies at most `VERIFY_CAP` (40) candidates — twice the 20-comment inline cap — ranked by
`severity_hint`, then by how many finders raised the candidate, then input order.
When it reports `overflow`, pass its `anomaly` string through `context.render.RUN_ANOMALY` so the report
says how many candidates went unverified; `finalize.mjs` merges it with every other anomaly.
Never verify the overflow in a second pass to get under the cap, and never drop it without the
anomaly.
Round 8 kept 118 candidates after dedupe and planned 33 batches in 6 messages, about 32 minutes of
verification for a report that posts at most 20 comments inline.
A batched verifier judges each candidate as if it were the only one: it writes one verdict per
candidate, in the order given, and never lets one candidate's evidence or verdict inform another's.
The expected count per thoroughness band is
[`depth-routing.md § Expected sub-agents per band`](./depth-routing.md#expected-sub-agents-per-band).

**Messages, queueing, and no re-dispatch.**

1. A message carries at most `PR_REVIEW_MAX_PARALLEL` (6) dispatches.
   Units beyond the cap wait in the queue `plan-dispatch.mjs` printed.
2. Send the next message only after every dispatch in the current one has returned.
   Phase D (finders, the lens bundle, the standards lens) goes first; Phase E (verifier batches)
   starts after dedupe, because its input is Phase D's output.
3. Dispatch each unit exactly once.
   A unit that returned a readable output path is done and is never re-dispatched.
4. The only second dispatch of a unit is one retry when it returned no readable output file.
   A second failure is recorded as a `RUN_ANOMALY` naming the unit, never retried a third time.
   Step f's one shape-repair round in `SKILL.md` is a separate, already-bounded case.

```text
# correct: --fanout on a 6,600-line packet — 12 finder shards + 2 lens units at a cap of 6
message 1: correctness@1..@3, consumer-impact@1..@3   → wait for all 6
message 2: dependency, intent, standards, quality@1..@3
message 3: lens-bundle, standards-conformance

# incorrect: 12 dispatches in one message, then re-dispatching the ones the harness queued
message 1: all 12 → 4 come back late → dispatch those 4 again
```

## Reading a budget into dispatch

Bind the budget once, right after `DEPTH_TIER` — `resolveBudget({ thoroughness, routedTier:
DEPTH_TIER, shape: DELTA_SHAPES, dispatchAvailable: <Task held?> })` — and every downstream step
reads it, never re-derives it:

- **`budget.finders`** — which of the six finders are active at all (`correctness`, `intent`,
  `quality` always are; `consumer-impact` / `dependency` / `standards` activate together once
  thoroughness clears the mid breakpoint). Skip an inactive finder exactly as `finders.md`'s own
  availability table already instructs; nothing here changes *which* finders exist, only whether
  each one runs this pass.
- **`budget.finderScope`** — `"delta"` vs `"all"` for `consumer-impact` and `standards`, same
  meaning `pr-reviewer.md`'s Step 2.4d/2.4e scope language already uses.
- **`budget.correctnessVotes`** — always `1` (votes retired; see *Diversify then vote* below). A
  single pass, with `votes` omitted.
- **`budget.topology`** — `"in-context"`, `"hybrid"`, or `"parallel"` (see *The three topologies*
  above). `"hybrid"` dispatches only `budget.isolatedFinders` and runs everything else in the
  orchestrator's turn; `"parallel"` — reached only through `--fanout` — dispatches every active finder
  (the per-file ones sharded), in as few messages as the cap allows (see *Packing* above);
  `"in-context"` dispatches nothing. `budget` already folds `dispatchAvailable` into this field — a
  caller never checks `Task` separately.
- **`budget.maxVerificationTier`** — the ceiling on `verify-behavior`'s Tier 1–3 evidence ladder a
  verifier dispatch may reach for this run (`finding-verifier.md`'s own per-candidate judgment still
  decides whether a given candidate needs it).
- **`budget.holisticEscalationCap`** — replaces the flat "cap 10" / "cap 3" language at 2.4b with
  `budget.holisticEscalationCap` directly; `2.4b`'s own incremental-mode gate (`ESCALATE_IN_INCREMENTAL`)
  is unchanged and still decides *whether* 2.4b runs at all in incremental mode.
- **`budget.optimalityLens`** / **`budget.measurabilityLens`** — replace the flat `DEPTH_TIER ==
  "deep"` / `DEPTH_TIER != "quick"` gates at 2.4c/2.4e with these booleans directly.
  Under `"parallel"`, the active ones and the holistic broad pass (`budget.holisticBroadPass`) run
  together in **one lens-bundle dispatch** that writes each lens's output separately; the
  standards-conformance lens is its own dispatch (see *Packing* above).

**`prepare-review.mjs` cannot know whether the agent reading `context.json` holds `Task`**, so the
`budget` it writes there always assumes `dispatchAvailable: true` and no `--fanout` — so it says
`hybrid` at `t ≥ 0.4`. The agent re-derives the real value itself:
`topology = <Task held?> ? context.budget.topology : "in-context"`. Every other field
on `budget` (finders, scope, votes, verifier tier, the two lens booleans, the escalation cap) is
unaffected by dispatch availability and is read straight off `context.json`.

**Verification dispatch, when `budget.topology == "parallel"`:** one verifier per batch that
`plan-dispatch.mjs --verifier-batches` planned — at most `VERIFY_BATCH_MAX` (8) candidates, no two
sharing a `path` — sent at most `PR_REVIEW_MAX_PARALLEL` (6) per message.
**When `budget.topology` is `"in-context"` or `"hybrid"`:** sequential, in the orchestrator's own turn.
The orchestrator is then its own verifier, so it takes the same two steps a verifier dispatch does:
read `comment-spine.mjs --shape-caps` once before writing any candidate's `title`, `body`, or
`evidence_anchors`, and run `validate-judgments.mjs --shape-only` on its candidates before
`finalize.mjs`, under the same 2-round bound.
In A/B rounds 3–5 the in-context arms skipped both and spent up to four validate rounds on
evidence notes over the cap.

**No-dispatch fallback is a degrade, not a silent equivalence — name it.** `resolveBudget()` already
returns `topology: "in-context"` whenever `dispatchAvailable` is `false`, whatever thoroughness
requested — it never silently reports a shape it could not run. When that happened on a run whose
thoroughness would otherwise have crossed the 0.4 breakpoint, set, for the default `hybrid` shape:

```text
RUN_ANOMALY: no sub-agent dispatch available — the intent finder ran in-context with the other
finders at effective thoroughness <t>, instead of as its own sub-agent
```

and for `--fanout`'s `parallel` shape, the line naming the parallel topology instead.

Set it by passing **`--no-dispatch`** to `finalize.mjs`, never by hand-writing it.
`finalize.mjs` renders the line from `context.budget` (only when the budget's topology was `hybrid`
or `parallel`, with its own effective thoroughness) and merges it with every other anomaly it
computes.
A value you also supply in `context.render.RUN_ANOMALY` is merged in, never a replacement: in A/B
iteration 2 every in-context arm hand-wrote this line there, which dropped `prepare-review.mjs`'s
own anomalies until the arm noticed and re-merged them.

```text
# correct
finalize.mjs --context … --judgments … --out-dir … --dry-run --no-dispatch

# incorrect: the hand-written line replaced finalize's computed anomalies before iteration 2
jq '.render.RUN_ANOMALY = "no sub-agent dispatch available — …"' context.json
```

This is the same `RUN_ANOMALY` slot every other capability cap in this pipeline uses
([`report-rendering.md § Run slots`](./report-rendering.md)) — never a quiet downgrade a reader has
to infer from a shorter run.

## Diversify then vote (moved here from the agent body) — retired

`budget.correctnessVotes` is `1` at every thoroughness, so the correctness finder runs once and
`votes` is omitted on every path.
`finders.md`'s *Diversify then vote* section describes the mechanism; this budget decides `N`, and
`N` is now 1.
The mechanism was meant to corroborate: a candidate raised by ≥ 2 votes over permuted file order
carries `votes`.
Round 8 measured the opposite — two votes raised 24 and 25 candidates and dedupe merged few of them
across the two, so the votes added work for the verifier rather than agreement, at ~10 minutes of
one worker each.
Sharding the per-file finders now addresses the uneven-attention problem permuted order was for:
each shard reads a third of a long packet instead of the tail of all of it.
Reintroduce votes only with a run that shows them adding **confirmed** recall, and change
`route-depth.mjs`'s `CORRECTNESS_VOTES` and `depth-routing.md` together.

## Worker prompts

Every sub-agent this topology dispatches — each finder in Phase D, each verifier in Phase E — gets
the **same worker preamble** `skills/quality/pr-review/SKILL.md`'s `--fanout` orchestration already
defines, reused verbatim by reference rather than restated here:
[`skills/quality/pr-review/SKILL.md § Worker preamble`](../../../skills/quality/pr-review/SKILL.md#worker-preamble--every-dispatch-in-steps-c-e-and-f).
It tells the worker to read only the files it was handed by absolute path, never to read
`agents/pr-reviewer.md` itself, to read the review packet (`context.packet.path`) before opening any
workspace file, and to write its JSON output to a path and return only that path — never the payload
inline.

**A sharded `--fanout` worker names its packet part instead** — `context.packet.parts[k − 1].path`
for shard `k` (`correctness@2` reads part 2).
A part keeps the description and the whole file index, and inlines only that shard's files,
rendered byte-identically to the full packet; those files are the worker's whole scope.

**Every finder, lens, and verifier dispatch names the review packet by absolute path.** It is the
largest single cut in a worker's turn count: an isolated intent finder on sync-tray#72 spent 21–40
tool calls and 5–6 minutes, most of them paging a 5,260-line diff and opening files around hunks to
see context and find a line number to cite — all of which `review-packet.mjs` assembles once,
before any model turn, with head line numbers on every line.

Every verifier dispatch's prompt additionally carries the live shape caps, pasted verbatim, never
restated as fixed numbers:

```bash
node agents/pr-reviewer/scripts/comment-spine.mjs --shape-caps
```

so `title`, `body`, `evidence[]`, and the fenced-suggestion line cap a verifier writes against are
checked against the caps the renderer will actually enforce, never a value someone remembered.

Every verifier dispatch's prompt also ends with the **verifier self-check** block, appended after the
preamble and the shape caps, verbatim and by reference:
[`skills/quality/pr-review/SKILL.md § Verifier self-check`](../../../skills/quality/pr-review/SKILL.md#verifier-self-check--appended-to-every-verifier-dispatch-in-step-e).
It tells the verifier to run `validate-judgments.mjs --shape-only` on its own output file before
returning, fix only the fields the check names, and stop after 2 fix-and-rerun rounds.
It must never change a verdict, a severity, or `blocking` to pass the check — except the one error
that is the severity crosswalk rather than a shape rule, which it resolves by re-applying the
crosswalk.
The single-dispatch path uses the same block as `--fanout`, for the same reason it uses the same
preamble: one copy, so a verifier dispatched by either path runs the same check.
A verifier that returns `SHAPE-UNRESOLVED` changes nothing downstream.
`finalize.mjs`'s `coerceShape()` still routes the candidate, and never drops it.
