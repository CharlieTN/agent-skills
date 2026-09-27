#!/usr/bin/env node
// @ts-check
// plan-dispatch.mjs — how many sub-agents a review dispatches, and in what grouping (A/B round 2
// item 6, revised in A/B round 8, plan feat/pr-reviewer-shrink-fanout-ab).
//
// Three topologies, chosen by resolveBudget() (route-depth.mjs):
//
//   in-context  no sub-agents (t < 0.4, or no dispatch capability).
//   hybrid      the DEFAULT at t >= 0.4: the review runs in one context and only the intent finder
//               is its own sub-agent (A/B rounds 7–8: isolated, it flagged the top defect 3 of 3
//               times; the full fan-out found everything but projected to ~57 minutes).
//   parallel    `/pr-review --fanout` only: every finder its own sub-agent, and the per-file finders
//               (correctness, consumer-impact, quality) SHARDED across packet parts when the packet
//               is over SHARD_LINES, so each worker reads only its part (review-packet.mjs).
//
// Verification under `parallel` is packed into batches of at most VERIFY_BATCH_MAX. Two candidates
// CONFLICT — may not share a batch — when they share a path AND sit within REGION_LINES of each
// other or name the same symbol: the independence rule is about one region of code judged twice,
// and round 8 showed a path-only key made one 33-candidate file force 33 batches. At most
// VERIFY_CAP candidates are verified, highest severity and most corroborated first; the rest are
// reported as an anomaly, never dropped silently.
//
// Correctness votes are retired (route-depth.mjs CORRECTNESS_VOTES): round 8's two votes added 24
// and 25 candidates rather than corroborating each other.
//
// rules/dispatch-topology.md owns the prose contract, rules/depth-routing.md § Expected sub-agents
// per band carries the table `--table` prints, and L1 G84g diffs the two.
//
// Usage:
//   node plan-dispatch.mjs --verifier-batches <candidates.json> [--batch-max <n>] [--cap <n>]
//       <candidates.json>: a JSON array, or an object with `candidates` or `kept` (deduped.json).
//       Prints { batchMax, cap, regionLines, verified, batches, overflow, anomaly, messages }.
//   node plan-dispatch.mjs --count --thoroughness <t> [--routed-tier <tier>] [--candidates <n>]
//       [--depth-capability <cap>] [--dispatch-unavailable] [--fanout] [--packet-lines <n>]
//       Prints the dispatch plan for that budget — packed and unpacked counts side by side.
//   node plan-dispatch.mjs --table
//       Prints the depth-routing.md table rows.
//   node plan-dispatch.mjs --self-test

import { readFileSync } from "node:fs";
import { resolveBudget } from "./route-depth.mjs";
import { shardCount, SHARDABLE_FINDERS } from "./review-packet.mjs";

/** Sub-agent dispatches per message — the concurrency cap. rules/dispatch-topology.md and
 *  skills/quality/pr-review/SKILL.md state the same number; L1 G84g holds all three equal. */
export const PR_REVIEW_MAX_PARALLEL = 6;

/** Candidates per verifier dispatch. A batch's own verification work stays well under the
 *  dispatch's base cost at 8, while 8 still cuts a 20-candidate run from 20 dispatches to 3. */
export const VERIFY_BATCH_MAX = 8;

/** The most candidates a `--fanout` run verifies: twice the 20-comment inline cap. Round 8 kept 118
 *  candidates after dedupe, which planned 33 batches in 6 messages (~32 minutes) for a report that
 *  can post 20 inline. */
export const VERIFY_CAP = 40;

/** Two same-path candidates at most this many lines apart share a region and never share a batch. */
export const REGION_LINES = 40;

/** The lenses that share one dispatch. standards-conformance is excluded on purpose. */
export const LENS_BUNDLE = Object.freeze(["holistic", "optimality", "measurability"]);

/** finders.md's own table order — the order units are listed, so a plan is deterministic. */
const FINDER_ORDER = ["correctness", "consumer-impact", "dependency", "intent", "standards", "quality"];

const SEVERITY_RANK = /** @type {Record<string, number>} */ ({ critical: 4, high: 3, medium: 2, low: 1 });

/**
 * @typedef {{ kind: "finder"|"lens-bundle"|"lens"|"verifier", id: string, finder?: string,
 *   shard?: number, lenses?: string[], members?: number[] }} Unit
 * @typedef {import("./route-depth.mjs").Budget} Budget
 */

/**
 * The finder dispatches. `hybrid` dispatches only `budget.isolatedFinders`; `parallel` dispatches
 * every active finder, splitting each shardable one into `shards` units (`correctness@1` …).
 * @param {Budget} budget
 * @param {{ shards?: number }} [opts]
 * @returns {Unit[]}
 */
export function finderUnits(budget, opts = {}) {
  if (budget.topology === "in-context") return [];
  const shards = Math.max(1, Math.floor(opts.shards ?? 1));
  /** @type {Unit[]} */
  const units = [];
  for (const f of FINDER_ORDER) {
    if (!budget.finders[/** @type {keyof Budget["finders"]} */ (f)]) continue;
    if (budget.topology === "hybrid" && !budget.isolatedFinders.includes(f)) continue;
    if (budget.topology === "parallel" && shards > 1 && SHARDABLE_FINDERS.includes(f)) {
      for (let k = 1; k <= shards; k++) units.push({ kind: "finder", id: `${f}@${k}`, finder: f, shard: k });
    } else {
      units.push({ kind: "finder", id: f, finder: f });
    }
  }
  return units;
}

/**
 * The lens dispatches — `parallel` only; under `hybrid` the lenses run in the orchestrator's
 * context. `skip` names lenses a run turned off by flag or by its own gate (`--no-holistic`, the
 * incremental-mode 2.4 skip, `TRIVIAL_SKIP`, …).
 * @param {Budget} budget
 * @param {{ skip?: string[], packing?: boolean }} [opts]
 * @returns {Unit[]}
 */
export function lensUnits(budget, opts = {}) {
  if (budget.topology !== "parallel") return [];
  const skip = new Set(opts.skip ?? []);
  const packing = opts.packing ?? true;
  /** @type {string[]} */
  const bundle = [];
  if (budget.holisticBroadPass && !skip.has("holistic")) bundle.push("holistic");
  if (budget.optimalityLens && !skip.has("optimality")) bundle.push("optimality");
  if (budget.measurabilityLens && !skip.has("measurability")) bundle.push("measurability");
  /** @type {Unit[]} */
  const units = [];
  if (packing && bundle.length > 0) {
    units.push({ kind: "lens-bundle", id: "lens-bundle", lenses: bundle });
  } else {
    for (const l of bundle) units.push({ kind: "lens", id: l, lenses: [l] });
  }
  // Tied to the standards FINDER's activation, exactly as pr-reviewer.md Step 2.4d gates it.
  if (budget.finders.standards && !skip.has("standards-conformance")) {
    units.push({ kind: "lens", id: "standards-conformance", lenses: ["standards-conformance"] });
  }
  return units;
}

/**
 * How many independent finders raised a candidate: itself, plus every finder dedupe merged into it.
 * @param {any} c
 */
function corroboration(c) {
  const also = Array.isArray(c?._also_flagged_by) ? c._also_flagged_by.length : 0;
  const sem = Array.isArray(c?._semantic_merged) ? c._semantic_merged.length : 0;
  return 1 + also + sem;
}

/**
 * The candidates a run verifies, capped at `cap`: highest `severity_hint` (or `severity`) first,
 * then the most corroborated, then input order. Returns candidate indexes. Pure.
 * @param {any[]} candidates
 * @param {number} cap
 * @returns {{ verify: number[], overflow: number[] }}
 */
export function selectForVerification(candidates, cap) {
  const order = candidates.map((_, i) => i).sort((x, y) => {
    const cx = candidates[x] ?? {}, cy = candidates[y] ?? {};
    const sx = SEVERITY_RANK[String(cx.severity_hint ?? cx.severity ?? "")] ?? 0;
    const sy = SEVERITY_RANK[String(cy.severity_hint ?? cy.severity ?? "")] ?? 0;
    return sy - sx || corroboration(cy) - corroboration(cx) || x - y;
  });
  const keep = order.slice(0, Math.max(0, cap)).sort((x, y) => x - y);
  const drop = order.slice(Math.max(0, cap)).sort((x, y) => x - y);
  return { verify: keep, overflow: drop };
}

/**
 * Whether two candidates may not share a verifier batch: the same path, and either within
 * `regionLines` of each other, naming the same symbol, or one of them with no line (a whole-file
 * claim). A candidate with no path shares a region with nothing.
 * @param {any} a @param {any} b @param {number} regionLines
 */
export function conflicts(a, b, regionLines) {
  const pa = a?.path, pb = b?.path;
  if (typeof pa !== "string" || pa === "" || pa !== pb) return false;
  const sa = String(a?.symbol ?? "").trim().toLowerCase(), sb = String(b?.symbol ?? "").trim().toLowerCase();
  if (sa && sa !== "-" && sa === sb) return true;
  if (typeof a?.line !== "number" || typeof b?.line !== "number") return true;
  return Math.abs(a.line - b.line) <= regionLines;
}

/**
 * Plan verifier batches: select at most `cap` candidates, then place each into the least-loaded
 * batch that has room (< batchMax) and holds nothing it conflicts with, opening a new batch only
 * when none qualifies. Candidates with the most conflicts are placed first. Deterministic. Members
 * and overflow are indexes into `candidates`.
 * @param {any[]} candidates
 * @param {{ batchMax?: number, cap?: number, regionLines?: number }} [opts]
 */
export function planVerifierBatches(candidates, opts = {}) {
  const batchMax = opts.batchMax ?? VERIFY_BATCH_MAX;
  const cap = opts.cap ?? VERIFY_CAP;
  const regionLines = opts.regionLines ?? REGION_LINES;
  if (!Number.isInteger(batchMax) || batchMax < 1) {
    throw new Error(`batchMax must be a positive integer, got ${JSON.stringify(batchMax)}`);
  }
  if (!(cap === Infinity || (Number.isInteger(cap) && cap >= 0))) {
    throw new Error(`cap must be a non-negative integer or Infinity, got ${JSON.stringify(cap)}`);
  }
  if (!Array.isArray(candidates)) throw new Error("candidates must be an array");
  const { verify, overflow } = selectForVerification(candidates, cap);
  const degree = new Map(verify.map((i) => [i,
    verify.filter((j) => j !== i && conflicts(candidates[i], candidates[j], regionLines)).length]));
  const order = [...verify].sort((x, y) => (degree.get(y) ?? 0) - (degree.get(x) ?? 0) || x - y);
  /** @type {number[][]} */
  const loads = Array.from({ length: verify.length === 0 ? 0 : Math.ceil(verify.length / batchMax) }, () => []);
  for (const ci of order) {
    const fits = loads.map((_, k) => k)
      .filter((k) => loads[k].length < batchMax
        && !loads[k].some((m) => conflicts(candidates[ci], candidates[m], regionLines)))
      .sort((x, y) => loads[x].length - loads[y].length || x - y);
    if (fits.length) loads[fits[0]].push(ci); else loads.push([ci]);
  }
  const batches = loads.map((members, k) => {
    members.sort((x, y) => x - y);
    return {
      id: `v${String(k + 1).padStart(2, "0")}`,
      members,
      paths: members.map((i) => {
        const pth = candidates[i]?.path;
        return typeof pth === "string" ? pth : null;
      }),
    };
  });
  const anomaly = overflow.length > 0
    ? `${overflow.length} of ${candidates.length} candidates not verified — over the verification cap of ${cap}`
      + ", lowest severity and least corroborated first"
    : null;
  return { batchMax, cap, regionLines, verified: verify.length, batches, overflow, anomaly };
}

/**
 * Chunk units into messages of at most `maxParallel` dispatches. Messages go out one at a time:
 * the next is sent only after every dispatch in the current one has returned.
 * @template T
 * @param {T[]} units
 * @param {{ maxParallel?: number }} [opts]
 * @returns {T[][]}
 */
export function planMessages(units, opts = {}) {
  const maxParallel = opts.maxParallel ?? PR_REVIEW_MAX_PARALLEL;
  if (!Number.isInteger(maxParallel) || maxParallel < 1) {
    throw new Error(`maxParallel must be a positive integer, got ${JSON.stringify(maxParallel)}`);
  }
  /** @type {T[][]} */
  const out = [];
  for (let i = 0; i < units.length; i += maxParallel) out.push(units.slice(i, i + maxParallel));
  return out;
}

/**
 * The whole plan for one budget. `candidates` is either the surviving candidates (their paths
 * decide the batches) or a count, read as that many candidates on distinct paths — the lower
 * bound, which is what the depth-routing.md table states. `packetLines` decides the shard count.
 * @param {Budget} budget
 * @param {{ candidates?: any[] | number, skip?: string[], packing?: boolean,
 *   batchMax?: number, maxParallel?: number, packetLines?: number }} [opts]
 */
export function planDispatch(budget, opts = {}) {
  const packing = opts.packing ?? true;
  const batchMax = packing ? (opts.batchMax ?? VERIFY_BATCH_MAX) : 1;
  const shards = budget.topology === "parallel" ? shardCount(opts.packetLines ?? 0) : 1;
  const finders = finderUnits(budget, { shards });
  const lenses = lensUnits(budget, { skip: opts.skip, packing });
  const raw = opts.candidates ?? 0;
  const candidates = typeof raw === "number"
    ? Array.from({ length: Math.max(0, Math.floor(raw)) }, (_, i) => ({ path: `distinct-${i}` }))
    : raw;
  const plan = budget.topology === "parallel"
    ? planVerifierBatches(candidates, { batchMax, cap: packing ? VERIFY_CAP : Infinity })
    : null;
  /** @type {Unit[]} */
  const verifiers = plan ? plan.batches.map((b) => ({ kind: "verifier", id: b.id, members: b.members })) : [];
  const phaseD = [...finders, ...lenses];
  const maxParallel = opts.maxParallel ?? PR_REVIEW_MAX_PARALLEL;
  return {
    topology: budget.topology,
    shards,
    finders: finders.length,
    lenses: lenses.length,
    verifiers: verifiers.length,
    subagents: finders.length + lenses.length + verifiers.length,
    unverified: plan ? plan.overflow.length : 0,
    messages: {
      phaseD: planMessages(phaseD, { maxParallel }).length,
      phaseE: planMessages(verifiers, { maxParallel }).length,
    },
    units: { phaseD, phaseE: verifiers },
  };
}

/* ------------------------------ the doc table ------------------------------ */

/** The bands, keyed by a representative `t` at each band's lower edge (0 for the first). */
export const TABLE_BANDS = Object.freeze([
  { label: "`t < 0.4`", t: 0 },
  { label: "`0.4 ≤ t < 0.5`", t: 0.4 },
  { label: "`0.5 ≤ t < 0.7`", t: 0.5 },
  { label: "`0.7 ≤ t < 0.8`", t: 0.7 },
  { label: "`0.8 ≤ t < 0.95`", t: 0.8 },
  { label: "`t ≥ 0.95`", t: 0.95 },
]);

/** The candidate count the table's `--fanout` total assumes (and a packet under SHARD_LINES). */
export const TABLE_CANDIDATES = 10;

/** @returns {string[]} the header, separator, and one row per band */
export function tableRows() {
  const rows = [
    `| Band | Default (hybrid) sub-agents | \`--fanout\` finder dispatches | \`--fanout\` lens dispatches | \`--fanout\` verifier dispatches | \`--fanout\` total at ${TABLE_CANDIDATES} candidates |`,
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const band of TABLE_BANDS) {
    const def = planDispatch(resolveBudget({ thoroughness: band.t }), { candidates: TABLE_CANDIDATES });
    const defCell = def.topology === "hybrid"
      ? `${def.subagents} (${def.units.phaseD.map((u) => u.id).join(", ")})`
      : "0 (in-context)";
    const fb = resolveBudget({ thoroughness: band.t, fanout: true });
    const fan = planDispatch(fb, { candidates: TABLE_CANDIDATES });
    if (fan.topology !== "parallel") {
      rows.push(`| ${band.label} | ${defCell} | 0 | 0 | 0 (in-context) | 0 |`);
      continue;
    }
    const bundle = fan.units.phaseD.find((u) => u.kind === "lens-bundle");
    const lensCell = fan.lenses === 0 ? "0"
      : `${fan.lenses} (${[bundle ? bundle.lenses?.join(" + ") : null,
        fan.units.phaseD.some((u) => u.id === "standards-conformance") ? "standards-conformance" : null]
        .filter(Boolean).join("; ")})`;
    rows.push(`| ${band.label} | ${defCell} | ${fan.finders} | ${lensCell} | ⌈min(V, ${VERIFY_CAP}) / ${VERIFY_BATCH_MAX}⌉ | ${fan.subagents} |`);
  }
  return rows;
}

/* --------------------------------- self-test --------------------------------- */

function selfTest() {
  let passed = 0;
  /** @type {string[]} */
  const fails = [];
  /** @param {string} name @param {boolean} ok @param {string} [detail] */
  const check = (name, ok, detail = "") => {
    if (ok) { passed++; console.log(`  ✓ ${name}`); } else { fails.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
  };
  /** @param {Array<[string, number?, string?]>} specs */
  const cands = (specs) => specs.map(([path, line, symbol]) => ({ path, line: line ?? 1, symbol: symbol ?? null }));
  /** @param {ReturnType<typeof planVerifierBatches>} plan @param {number[]} expected */
  const isPartitionOf = (plan, expected) => {
    const seen = plan.batches.flatMap((b) => b.members).sort((a, b) => a - b);
    return JSON.stringify(seen) === JSON.stringify([...expected].sort((a, b) => a - b));
  };
  /** @param {any[]} list @param {ReturnType<typeof planVerifierBatches>} plan */
  const conflictFree = (list, plan) => plan.batches.every((b) =>
    b.members.every((x, i) => b.members.slice(i + 1).every((y) => !conflicts(list[x], list[y], plan.regionLines))));
  const all = (/** @type {number} */ n) => Array.from({ length: n }, (_, i) => i);

  // ---- planVerifierBatches ----
  check("no candidates → no batches", planVerifierBatches([]).batches.length === 0);

  const distinct20 = cands(Array.from({ length: 20 }, (_, i) => [`f${i}.ts`]));
  const d20 = planVerifierBatches(distinct20);
  check("20 candidates on distinct paths → 3 batches (⌈20/8⌉), loads 7/7/6",
    d20.batches.length === 3
      && JSON.stringify(d20.batches.map((b) => b.members.length).sort()) === JSON.stringify([6, 7, 7]),
    JSON.stringify(d20.batches.map((b) => b.members.length)));
  check("every candidate lands in exactly one batch", isPartitionOf(d20, all(20)));

  const hotFar = cands(Array.from({ length: 10 }, (_, i) => ["hot.ts", 100 + i * 200]));
  const hf = planVerifierBatches(hotFar);
  check("10 candidates on ONE path but in 10 distinct regions → 2 batches, not 10 (A/B round 8)",
    hf.batches.length === 2 && isPartitionOf(hf, all(10)), String(hf.batches.length));

  const hotNear = cands(Array.from({ length: 10 }, (_, i) => ["hot.ts", 100 + i * 4]));
  const hn = planVerifierBatches(hotNear);
  check("10 candidates in ONE region of one file → 10 single-candidate batches (the region rule wins over batchMax)",
    hn.batches.length === 10 && hn.batches.every((b) => b.members.length === 1));

  const sameSymbol = cands([["s.ts", 10, "run"], ["s.ts", 900, "run"], ["s.ts", 500, "other"]]);
  const ss = planVerifierBatches(sameSymbol);
  check("two same-path candidates naming the same symbol never share a batch, however far apart",
    conflictFree(sameSymbol, ss) && ss.batches.length === 2, JSON.stringify(ss.batches.map((b) => b.members)));

  const wholeFile = [{ path: "w.ts", line: null, symbol: null }, { path: "w.ts", line: 800, symbol: null }];
  check("a same-path candidate with no line conflicts with every other on that path",
    planVerifierBatches(wholeFile).batches.length === 2);

  const mixed = cands([["a.ts", 10], ["a.ts", 20], ["a.ts", 700], ["b.ts", 5], ["b.ts", 30], ["c.ts"], ["d.ts"],
    ["e.ts", 1], ["e.ts", 400], ["f.ts"], ["g.ts"], ["h.ts"], ["a.ts", 15], ["i.ts"], ["j.ts"], ["k.ts"], ["l.ts"], ["m.ts"]]);
  const mx = planVerifierBatches(mixed);
  check("mixed: a partition, conflict-free, every batch within batchMax",
    isPartitionOf(mx, all(mixed.length)) && conflictFree(mixed, mx) && mx.batches.every((b) => b.members.length <= VERIFY_BATCH_MAX));
  check("mixed: 3 batches — the a.ts region holding 3 candidates sets the floor above ⌈18/8⌉",
    mx.batches.length === 3, String(mx.batches.length));

  const anchorless = planVerifierBatches([{ path: undefined }, { path: "" }, {}, { path: "x.ts", line: 1 }]);
  check("candidates with no path conflict with nothing (batched together, never refused)",
    anchorless.batches.length === 1 && anchorless.batches[0].members.length === 4);

  const again = planVerifierBatches(mixed);
  check("deterministic: the same input plans the same batches", JSON.stringify(again) === JSON.stringify(mx));

  // ---- the verification cap ----
  const ranked = [
    { path: "a.ts", line: 1, severity_hint: "low" },
    { path: "b.ts", line: 1, severity_hint: "high" },
    { path: "c.ts", line: 1, severity_hint: "medium", _also_flagged_by: ["quality"] },
    { path: "d.ts", line: 1, severity_hint: "medium" },
    { path: "e.ts", line: 1, severity_hint: "critical" },
  ];
  const capped = planVerifierBatches(ranked, { cap: 3 });
  check("the cap keeps the highest severity, then the most corroborated",
    JSON.stringify(capped.batches.flatMap((b) => b.members).sort()) === JSON.stringify([1, 2, 4])
      && JSON.stringify(capped.overflow) === JSON.stringify([0, 3]), JSON.stringify(capped.overflow));
  check("an over-cap run names the overflow as an anomaly, never silently",
    capped.verified === 3 && /^2 of 5 candidates not verified — over the verification cap of 3/.test(capped.anomaly || ""));
  check("at or under the cap there is no overflow and no anomaly",
    planVerifierBatches(ranked).overflow.length === 0 && planVerifierBatches(ranked).anomaly === null);
  const many = cands(Array.from({ length: 118 }, (_, i) => [`f${i % 16}.ts`, (i * 97) % 3700]));
  const mplan = planVerifierBatches(many);
  check("round 8's shape (118 candidates on 16 files) verifies VERIFY_CAP in ⌈40/8⌉-ish batches",
    mplan.verified === VERIFY_CAP && mplan.overflow.length === 118 - VERIFY_CAP && mplan.batches.length <= 7,
    String(mplan.batches.length));

  let threw = 0;
  for (const bad of [0, -1, 1.5, NaN]) {
    try { planVerifierBatches(cands([["a"]]), { batchMax: bad }); } catch { threw++; }
  }
  check("an invalid batchMax (0, -1, 1.5, NaN) throws rather than planning", threw === 4);

  // ---- planMessages ----
  const msgs = planMessages(Array.from({ length: 14 }, (_, i) => i));
  check("14 units at the default cap → messages of 6, 6, 2",
    JSON.stringify(msgs.map((m) => m.length)) === JSON.stringify([6, 6, 2]));
  check("no message exceeds PR_REVIEW_MAX_PARALLEL", msgs.every((m) => m.length <= PR_REVIEW_MAX_PARALLEL));

  // ---- planDispatch: the default (hybrid) path ----
  const quick = planDispatch(resolveBudget({ routedTier: "quick" }), { candidates: 10 });
  check("quick (t=0.2): in-context, zero sub-agents", quick.topology === "in-context" && quick.subagents === 0);
  const standard = planDispatch(resolveBudget({ routedTier: "standard" }), { candidates: 10 });
  check("standard (t=0.5) default: hybrid, one sub-agent — the intent finder",
    standard.topology === "hybrid" && standard.subagents === 1 && standard.units.phaseD[0]?.id === "intent");
  const deep = planDispatch(resolveBudget({ routedTier: "deep" }), { candidates: 10, packetLines: 6612 });
  check("deep (t=0.8) default: still one sub-agent, no lenses, no verifier dispatch, no shards",
    deep.subagents === 1 && deep.lenses === 0 && deep.verifiers === 0 && deep.shards === 1);

  // ---- planDispatch: --fanout ----
  const fanDeep = planDispatch(resolveBudget({ routedTier: "deep", fanout: true }), { candidates: 10 });
  const fanBundle = fanDeep.units.phaseD.find((u) => u.kind === "lens-bundle");
  check("--fanout deep: 6 finders (votes retired), one lens bundle, standards-conformance alone",
    fanDeep.finders === 6 && JSON.stringify(fanBundle?.lenses) === JSON.stringify(["holistic", "optimality", "measurability"])
      && fanDeep.units.phaseD.some((u) => u.id === "standards-conformance" && u.kind === "lens")
      && fanDeep.units.phaseD.filter((u) => u.finder === "correctness").length === 1);
  const fanSharded = planDispatch(resolveBudget({ routedTier: "deep", fanout: true }), { candidates: 10, packetLines: 6612 });
  check("--fanout on a 6,612-line packet: correctness, consumer-impact and quality split into 3 shards each",
    fanSharded.shards === 3 && fanSharded.finders === 12
      && ["correctness", "consumer-impact", "quality"].every((f) => fanSharded.units.phaseD.filter((u) => u.finder === f).length === 3)
      && fanSharded.units.phaseD.filter((u) => u.finder === "intent").length === 1);
  const fanNoDispatch = planDispatch(resolveBudget({ routedTier: "deep", fanout: true, dispatchAvailable: false }), { candidates: 10 });
  check("no dispatch capability: zero sub-agents, whatever the topology asked for", fanNoDispatch.subagents === 0);
  const diffOnly = planDispatch(resolveBudget({ routedTier: "deep", depthCapability: "diff-only", fanout: true }), { candidates: 0 });
  check("--fanout diff-only: consumer-impact is not dispatched (5 finders)",
    diffOnly.finders === 5 && !diffOnly.units.phaseD.some((u) => u.finder === "consumer-impact"));
  const skipped = planDispatch(resolveBudget({ routedTier: "deep", fanout: true }), { skip: ["holistic", "optimality", "measurability"] });
  check("a lens skipped by its own gate leaves the bundle; an empty bundle is not dispatched",
    !skipped.units.phaseD.some((u) => u.kind === "lens-bundle") && skipped.lenses === 1);

  // ---- packing never costs a dispatch ----
  let regressed = "";
  for (const t of [0, 0.2, 0.4, 0.45, 0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 0.95, 1]) {
    for (const fanout of [false, true]) {
      for (const n of [0, 1, 5, 8, 9, 20, 40]) {
        const b = resolveBudget({ thoroughness: t, fanout });
        const pk = planDispatch(b, { candidates: n });
        const up = planDispatch(b, { candidates: n, packing: false });
        if (pk.subagents > up.subagents || pk.finders !== up.finders) regressed ||= `t=${t} fanout=${fanout} n=${n}: packed ${pk.subagents} vs unpacked ${up.subagents}`;
      }
    }
  }
  check("packing never dispatches more sub-agents than unpacked, and never merges a finder", regressed === "", regressed);

  // ---- the doc table ----
  const rows = tableRows();
  check("the table has a header, a separator, and one row per band", rows.length === 2 + TABLE_BANDS.length);
  check("the t < 0.4 row is zero sub-agents on both paths",
    /^\| `t < 0\.4` \| 0 \(in-context\) \| 0 \| 0 \| 0 \(in-context\) \| 0 \|$/.test(rows[2]), rows[2]);
  check("every band from 0.4 up is one default sub-agent (intent)",
    rows.slice(3).every((r) => r.includes("| 1 (intent) |")), rows.slice(3).join(" / "));

  console.log(`plan-dispatch self-test: ${passed}/${passed + fails.length}`);
  if (fails.length) {
    console.log(`✗ plan-dispatch self-test: ${fails.length} failed`);
    process.exit(1);
  }
  console.log(`✓ plan-dispatch self-test: all ${passed} cases passed`);
}

/* ------------------------------------ CLI ------------------------------------ */

/** @param {string[]} args @param {string} flag */
function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) { selfTest(); return; }
  if (args.includes("--table")) { console.log(tableRows().join("\n")); return; }
  if (args.includes("--verifier-batches")) {
    const file = argValue(args, "--verifier-batches");
    if (!file) { console.error("usage: plan-dispatch.mjs --verifier-batches <candidates.json> [--batch-max <n>] [--cap <n>]"); process.exit(2); }
    const data = JSON.parse(readFileSync(file, "utf8"));
    const list = Array.isArray(data) ? data : Array.isArray(data?.candidates) ? data.candidates
      : Array.isArray(data?.kept) ? data.kept : null;
    if (list === null) { console.error("candidates file must be an array, or carry a `candidates` or `kept` array"); process.exit(2); }
    const bm = argValue(args, "--batch-max");
    const cp = argValue(args, "--cap");
    const plan = planVerifierBatches(list, {
      ...(bm === undefined ? {} : { batchMax: Number(bm) }),
      ...(cp === undefined ? {} : { cap: Number(cp) }),
    });
    console.log(JSON.stringify({
      batchMax: plan.batchMax,
      cap: plan.cap,
      regionLines: plan.regionLines,
      maxParallel: PR_REVIEW_MAX_PARALLEL,
      verified: plan.verified,
      batches: plan.batches,
      overflow: plan.overflow,
      anomaly: plan.anomaly,
      messages: planMessages(plan.batches.map((b) => b.id)),
    }, null, 2));
    return;
  }
  if (args.includes("--count")) {
    const t = argValue(args, "--thoroughness");
    const budget = resolveBudget({
      thoroughness: t === undefined ? undefined : Number(t),
      routedTier: /** @type {any} */ (argValue(args, "--routed-tier")),
      depthCapability: argValue(args, "--depth-capability"),
      dispatchAvailable: !args.includes("--dispatch-unavailable"),
      fanout: args.includes("--fanout"),
    });
    const n = Number(argValue(args, "--candidates") ?? 0);
    const pl = argValue(args, "--packet-lines");
    const packetLines = pl === undefined ? 0 : Number(pl);
    const packed = planDispatch(budget, { candidates: n, packetLines });
    const unpacked = planDispatch(budget, { candidates: n, packing: false, packetLines });
    console.log(JSON.stringify({
      effectiveThoroughness: budget.effectiveThoroughness,
      topology: packed.topology,
      shards: packed.shards,
      unverified: packed.unverified,
      packed: { finders: packed.finders, lenses: packed.lenses, verifiers: packed.verifiers,
        subagents: packed.subagents, messages: packed.messages },
      unpacked: { finders: unpacked.finders, lenses: unpacked.lenses, verifiers: unpacked.verifiers,
        subagents: unpacked.subagents, messages: unpacked.messages },
      phaseD: packed.units.phaseD.map((u) => u.id + (u.lenses && u.kind === "lens-bundle" ? ` [${u.lenses.join(", ")}]` : "")),
    }, null, 2));
    return;
  }
  console.error("usage: plan-dispatch.mjs --verifier-batches <file> | --count --thoroughness <t> | --table | --self-test");
  process.exit(2);
}

const isEntryPoint = process.argv[1] && process.argv[1].endsWith("plan-dispatch.mjs");
if (isEntryPoint) main();
