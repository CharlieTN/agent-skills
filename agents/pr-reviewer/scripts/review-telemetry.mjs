#!/usr/bin/env node
// @ts-check
// review-telemetry.mjs — per-step telemetry for one pr-reviewer run, exported as an OTLP trace in
// the shape Dash0's AI Coding Insights reads (OpenTelemetry GenAI conventions, plus the
// `dash0.gen_ai.vcs.*` keys the Dash0 agent plugin emits).
//
// WHY A LEDGER. A review is not one process: the model runs a dozen short commands
// (prepare-review.mjs, validate-judgments.mjs, finalize.mjs, …) with its own reasoning in between,
// and that reasoning is where most of the wall clock goes. Each step boundary therefore appends
// one line to `<run-dir>/telemetry.jsonl`; `finish` reads the ledger back and exports ONE trace.
// Gaps nobody marked are exported as `unmarked` steps, so the steps always add up to the run.
//
// THE TRACE (matches https://dash0.com/docs/dash0/darkplane/insights/span-attributes and the
// attribute contract in github.com/dash0hq/dash0-agent-plugin DEVELOPMENT.md):
//
//   invoke_agent pr-reviewer            gen_ai.operation.name=invoke_agent, gen_ai.agent.id=<run id>
//   ├─ pr_review.step prepare           pr_review.step.kind=script
//   ├─ pr_review.step finders           pr_review.step.kind=model
//   ├─ pr_review.step unmarked          a gap between marked steps
//   ├─ pr_review.worker intent          a sub-agent this run dispatched (hybrid, --fanout)
//   └─ …
//
// Identity and VCS attributes go on EVERY span, as the plugin does: gen_ai.agent.name,
// gen_ai.conversation.id, dash0.gen_ai.vcs.* (repository, owner, PR url, head ref and revision).
//
// THREE THINGS THIS FILE NEVER EMITS, and why:
//   - no `chat` span and no token counts — the harness owns model usage (the Dash0 agent plugin
//     reads it from the transcript); a script cannot see it, and a guessed number is worse than
//     none. Cost stays where it is measured.
//   - no `execute_tool` span — the plugin already emits one per tool call, so a second copy would
//     double every tool-call count in the Tools & Skills tab.
//   - no `gen_ai.harness.name` inside a harness the plugin covers (claude-code, cursor, codex,
//     github-copilot-cli) unless this run is joined to that harness's session through
//     `gen_ai.conversation.id` (PR_REVIEWER_CONVERSATION_ID) — otherwise every review would appear
//     as a second, zero-cost coding session next to the one the plugin already recorded.
//
// FOUR RULES (inherited from otlp.mjs, self-tested below):
//   1. Export is OPT-IN: PR_REVIEWER_OTLP_ENDPOINT (+ PR_REVIEWER_OTLP_HEADERS), or
//      PR_REVIEWER_TELEMETRY=on to reuse the standard OTEL_EXPORTER_OTLP_ENDPOINT/_HEADERS.
//      A host's own OTEL_* variables are never picked up silently: an Agent0 sandbox sets them for
//      its own process telemetry, and a review trace carries repository names, PR URLs and a git
//      user name that belong in the reviewer's own backend, not the host's.
//      PR_REVIEWER_TELEMETRY=off wins over everything. The ledger and the summary are written
//      either way — the breakdown needs no backend.
//   2. A miss is not an error: a step that finds nothing stays status UNSET.
//   3. An absent attribute is omitted, never a placeholder.
//   4. Telemetry never fails a review: every CLI command exits 0 (a misuse is a stderr warning),
//      and an unreachable backend is `exported: false`, never a throw.
//
// Usage (every command also reads the run dir from PR_REVIEW_RUN_DIR):
//   node review-telemetry.mjs begin  --run-dir <dir> [--repo o/r] [--pr n] [--head sha]
//        [--head-ref branch] [--mode m] [--tier t] [--thoroughness n] [--topology t] [--model id]
//        [--conversation-id id] [--harness name]
//   node review-telemetry.mjs step   <name> --run-dir <dir> [--attr key=value …]
//   node review-telemetry.mjs end    [<name>] --run-dir <dir> [--attr key=value …]
//   node review-telemetry.mjs attr   --run-dir <dir> [--target run|step] --attr key=value …
//   node review-telemetry.mjs worker <unit> start|end --run-dir <dir> [--attr key=value …]
//   node review-telemetry.mjs worker <unit> import --from <worker-dir> [--done <output-file>] --run-dir <dir>
//   node review-telemetry.mjs finish --run-dir <dir> [--status ok|error] [--message m] [--force]
//   node review-telemetry.mjs summary --run-dir <dir>
//   node review-telemetry.mjs --self-test
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { OtlpExporter, attrs } from "./otlp.mjs";

export { attrs };

/**
 * A wall-clock timing block builder. Independent of OTLP entirely — this is what every
 * artifact's `timing` field is built from, and it works with NO endpoint configured.
 */
export class Timing {
  constructor() {
    this._start = Date.now();
    /** @type {Record<string, number>} */
    this._phases = {};
    /** @type {string|null} */
    this._openPhase = null;
    /** @type {number|null} */
    this._openAt = null;
  }

  /** Start timing a named phase. Closes any phase left open by the caller — a forgotten `.end()`
   *  must not corrupt every phase after it.
   *  @param {string} name */
  start(name) {
    if (this._openPhase) this.end();
    this._openPhase = name;
    this._openAt = Date.now();
  }

  /** Close the currently open phase. Repeated calls to one name accumulate (a retry reports its
   *  total time). */
  end() {
    if (!this._openPhase || this._openAt === null) return;
    const ms = Date.now() - this._openAt;
    this._phases[this._openPhase] = (this._phases[this._openPhase] || 0) + ms;
    this._openPhase = null;
    this._openAt = null;
  }

  /** The epoch ms this timer was created — a process's own start, for its step span. */
  startedAt() {
    return this._start;
  }

  /** @returns {{phases: Record<string, number>, total_ms: number}} */
  block() {
    if (this._openPhase) this.end();
    return { phases: { ...this._phases }, total_ms: Date.now() - this._start };
  }
}

export const LEDGER_FILE = "telemetry.jsonl";
export const SUMMARY_FILE = "telemetry-summary.json";
export const AGENT_NAME = "pr-reviewer";
export const SCOPE_NAME = "agent-skills/pr-reviewer";

/** The step vocabulary and each step's kind. A name outside it is accepted (kind `model`) as long
 *  as it matches STEP_NAME_RE; the vocabulary keeps two runs' breakdowns comparable. */
export const STEPS = Object.freeze({
  prepare: "script",
  memory: "model",
  gates: "model",
  finders: "model",
  "intent-wait": "model",
  lenses: "model",
  consolidate: "model",
  verify: "model",
  judgments: "model",
  validate: "script",
  finalize: "script",
  post: "script",
  state: "model",
  "fanout-finders": "dispatch",
  dedupe: "script",
  "fanout-verify": "dispatch",
  assemble: "model",
});
const STEP_NAME_RE = /^[a-z][a-z0-9-]{0,39}$/;
/** A gap shorter than this between two marked steps is bookkeeping, not an unmarked step. */
const GAP_MIN_NS = 1_000_000_000n;

/** Harnesses the Dash0 agent plugin already records as coding sessions. */
export const PLUGIN_HARNESSES = new Set(["claude-code", "cursor", "codex", "github-copilot-cli"]);

/** Every attribute key a span may carry. The self-test holds every emitted span to it, so a new
 *  key is a deliberate edit here rather than a drift into Dash0's views. */
export const ALLOWED_SPAN_KEY = (/** @type {string} */ k) =>
  /^pr_review\.[a-z0-9_.]+$/.test(k)
  || /^dash0\.gen_ai\.vcs\.(repository\.url\.full|repository\.name|owner\.name|provider\.name|ref\.head\.name|ref\.head\.revision|ref\.head\.type|pull_request\.url)$/.test(k)
  || [
    "gen_ai.operation.name", "gen_ai.agent.name", "gen_ai.agent.id", "gen_ai.conversation.id",
    "gen_ai.harness.name", "gen_ai.provider.name", "gen_ai.request.model",
    "dash0.team.name", "user.name", "dash0.gen_ai.user.identity.source", "error.type",
  ].includes(k);

const HIST_BOUNDS = {
  "pr_review.step.duration": [5, 15, 30, 60, 120, 300, 600, 1200],
  "pr_review.run.duration": [60, 180, 300, 600, 900, 1200, 1800, 3600],
};

const nowNs = () => BigInt(Date.now()) * 1_000_000n;

/** OTel GenAI `gen_ai.provider.name` from a model id — the Dash0 agent plugin's own mapping.
 *  @param {string|null|undefined} model @returns {string|null} */
export function providerForModel(model) {
  const m = String(model || "");
  if (!m) return null;
  if (m.startsWith("claude-")) return "anthropic";
  if (m.startsWith("gpt-") || /^o[134](-|$)/.test(m) || m.startsWith("codex-")) return "openai";
  if (m.startsWith("gemini-")) return "gcp.gemini";
  if (m.startsWith("grok-")) return "x_ai";
  if (m.startsWith("deepseek-")) return "deepseek";
  if (m.startsWith("mistral-")) return "mistral_ai";
  return null;
}

/** @param {NodeJS.ProcessEnv} env @param {(p: string) => boolean} [exists] @returns {string|null} */
export function detectHarness(env, exists = existsSync) {
  if (env.PR_REVIEWER_HARNESS) return env.PR_REVIEWER_HARNESS;
  if (env.CLAUDECODE === "1") return "claude-code";
  // The repo's one Agent0-host detector (agents/shared/rules/agent0-host.md): this file, never a
  // failed call.
  if (exists("/tmp/workspace/agent-skills/env.sh")) return "agent0";
  return null;
}

/** @param {NodeJS.ProcessEnv} env @returns {string|null} */
export function detectConversationId(env) {
  return env.PR_REVIEWER_CONVERSATION_ID || env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID || null;
}

/** @param {NodeJS.ProcessEnv} env @returns {{ endpoint: string, headers: Record<string, string> }} */
export function exportTarget(env) {
  const mode = String(env.PR_REVIEWER_TELEMETRY || "").toLowerCase();
  if (mode === "off") return { endpoint: "", headers: {} };
  if (env.PR_REVIEWER_OTLP_ENDPOINT) {
    return { endpoint: env.PR_REVIEWER_OTLP_ENDPOINT, headers: parseHeaders(env.PR_REVIEWER_OTLP_HEADERS) };
  }
  if (mode === "on" && env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    return { endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT, headers: parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS) };
  }
  return { endpoint: "", headers: {} };
}

/** OTEL_EXPORTER_OTLP_HEADERS: `k=v,k2=v2`, values optionally percent-encoded (the spec's form).
 *  @param {string} [s] @returns {Record<string, string>} */
export function parseHeaders(s) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const pair of (s || "").split(",")) {
    const i = pair.indexOf("=");
    if (i <= 0) continue;
    const key = pair.slice(0, i).trim();
    let value = pair.slice(i + 1).trim();
    try { value = decodeURIComponent(value); } catch { /* not encoded — keep as written */ }
    out[key] = value;
  }
  return out;
}

/** @param {string} runId @returns {string} a 32-hex trace id, stable for a run */
export function traceIdFor(runId) {
  return createHash("sha256").update(`pr-reviewer:${runId}`).digest("hex").slice(0, 32);
}

/** @param {string} runId @param {string} key @returns {string} a 16-hex span id, stable for a run */
function spanIdFor(runId, key) {
  return createHash("sha256").update(`pr-reviewer:${runId}:${key}`).digest("hex").slice(0, 16);
}

/* ------------------------------------ the ledger ------------------------------------ */

/**
 * @typedef {{ t: string, ns: string, [k: string]: any }} LedgerRecord
 * @typedef {{ repo?: string, number?: number, head_sha?: string, head_ref?: string, mode?: string,
 *   tier?: string, thoroughness?: number, topology?: string, model?: string,
 *   conversation_id?: string, harness?: string, user_name?: string, version?: string }} RunFacts
 */

/** @param {string} runDir @returns {string} */
export function ledgerPath(runDir) {
  return join(runDir, LEDGER_FILE);
}

/** Append one record. `ns` defaults to now; pass it to backdate (a process's own start).
 *  @param {string} runDir @param {Record<string, any>} rec */
export function appendRecord(runDir, rec) {
  mkdirSync(runDir, { recursive: true });
  const { ns: at, ...rest } = rec;
  const line = JSON.stringify({ ns: String(at ?? nowNs()), ...rest });
  appendFileSync(ledgerPath(runDir), `${line}\n`, "utf8");
}

/** @param {string} runDir @returns {LedgerRecord[]} */
export function readLedger(runDir) {
  const p = ledgerPath(runDir);
  if (!existsSync(p)) return [];
  /** @type {LedgerRecord[]} */
  const out = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r.t === "string" && /^\d+$/.test(String(r.ns))) out.push(r);
    } catch { /* a torn line from a crash is skipped, never fatal */ }
  }
  return out;
}

/**
 * Start a run, or add facts to one already started (idempotent: a second `begin` never starts a
 * second trace). Returns the run id.
 * @param {string} runDir @param {RunFacts} facts @param {{ ns?: bigint|string }} [opts]
 */
export function beginRun(runDir, facts, opts = {}) {
  const records = readLedger(runDir);
  const existing = records.find((r) => r.t === "run");
  const clean = Object.fromEntries(Object.entries(facts).filter(([, v]) => v !== undefined && v !== null && v !== ""));
  if (existing) {
    // Same run: add facts. A FINISHED run, or one for another PR, is a previous review that shared
    // this directory (prepare-review's default --out is one fixed path) — rotate it aside rather
    // than folding this review into its trace.
    const prev = /** @type {RunFacts} */ (existing.facts || {});
    const otherPr = (clean.repo && prev.repo && clean.repo !== prev.repo) || (clean.number && prev.number && clean.number !== prev.number);
    if (!records.some((r) => r.t === "finish") && !otherPr) {
      appendRecord(runDir, { t: "facts", facts: clean });
      return String(existing.run_id);
    }
    renameSync(ledgerPath(runDir), join(runDir, `telemetry.${String(existing.run_id)}.jsonl`));
  }
  const runId = randomBytes(8).toString("hex");
  appendRecord(runDir, { t: "run", run_id: runId, facts: clean, ...(opts.ns === undefined ? {} : { ns: opts.ns }) });
  return runId;
}

/* ----------------------------------- building spans ----------------------------------- */

/**
 * @typedef {{ name: string, kind: string, marked: boolean, startNs: bigint, endNs: bigint,
 *   attrs: Record<string, any>, status: 0|2, message?: string }} StepSpan
 * @typedef {{ unit: string, startNs: bigint, endNs: bigint, attrs: Record<string, any> }} WorkerSpan
 * @typedef {{ runId: string, facts: RunFacts, startNs: bigint, endNs: bigint, steps: StepSpan[],
 *   workers: WorkerSpan[], runAttrs: Record<string, any>, status: 0|2, message?: string,
 *   finished: boolean }} BuiltRun
 */

/** Pure: a ledger → the run's spans. `now` closes whatever is still open when there is no finish.
 *  @param {LedgerRecord[]} records @param {bigint} [now] @returns {BuiltRun|null} */
export function buildRun(records, now = nowNs()) {
  const sorted = records.map((r, i) => ({ r, i, ns: BigInt(r.ns) }))
    .sort((a, b) => (a.ns < b.ns ? -1 : a.ns > b.ns ? 1 : a.i - b.i));
  const runRec = sorted.find((x) => x.r.t === "run");
  if (!runRec) return null;
  /** @type {RunFacts} */
  const facts = {};
  for (const { r } of sorted) if (r.t === "run" || r.t === "facts") Object.assign(facts, r.facts || {});
  const finish = [...sorted].reverse().find((x) => x.r.t === "finish");
  const startNs = runRec.ns;
  const endNs = finish ? finish.ns : now;

  /** @type {StepSpan[]} */
  const steps = [];
  /** @type {StepSpan|null} */
  let open = null;
  /** @type {Record<string, any>} */
  const runAttrs = {};
  /** @type {Map<string, WorkerSpan>} */
  const openWorkers = new Map();
  /** @type {WorkerSpan[]} */
  const workers = [];
  const close = (/** @type {bigint} */ at) => {
    if (open) { open.endNs = at < open.startNs ? open.startNs : at; steps.push(open); open = null; }
  };
  for (const { r, ns } of sorted) {
    if (ns > endNs && r.t !== "finish") continue;
    if (r.t === "step" && r.phase === "start") {
      close(ns);
      const name = String(r.name);
      open = { name, kind: STEPS[/** @type {keyof typeof STEPS} */ (name)] || "model", marked: true, startNs: ns, endNs: ns, attrs: { ...(r.attrs || {}) }, status: 0 };
    } else if (r.t === "step" && r.phase === "end") {
      if (open) Object.assign(open.attrs, r.attrs || {});
      close(ns);
    } else if (r.t === "attr") {
      if (r.target === "step" && open) Object.assign(open.attrs, r.attrs || {});
      else Object.assign(runAttrs, r.attrs || {});
    } else if (r.t === "worker") {
      const unit = String(r.unit);
      if (r.phase === "start") {
        openWorkers.set(unit, { unit, startNs: ns, endNs: ns, attrs: { ...(r.attrs || {}) } });
      } else {
        const w = openWorkers.get(unit) || { unit, startNs: ns, endNs: ns, attrs: {} };
        w.endNs = ns;
        Object.assign(w.attrs, r.attrs || {});
        workers.push(w);
        openWorkers.delete(unit);
      }
    }
  }
  close(endNs);
  for (const w of openWorkers.values()) { w.endNs = endNs; workers.push(w); }
  if (finish) Object.assign(runAttrs, finish.r.attrs || {});

  // Fill every gap longer than GAP_MIN_NS with an `unmarked` step, so the steps add up to the run.
  steps.sort((a, b) => (a.startNs < b.startNs ? -1 : a.startNs > b.startNs ? 1 : 0));
  /** @type {StepSpan[]} */
  const filled = [];
  let cursor = startNs;
  for (const s of steps) {
    if (s.startNs - cursor > GAP_MIN_NS) filled.push({ name: "unmarked", kind: "model", marked: false, startNs: cursor, endNs: s.startNs, attrs: {}, status: 0 });
    filled.push(s);
    if (s.endNs > cursor) cursor = s.endNs;
  }
  if (endNs - cursor > GAP_MIN_NS) filled.push({ name: "unmarked", kind: "model", marked: false, startNs: cursor, endNs, attrs: {}, status: 0 });

  const failed = finish?.r.status === "error";
  return {
    runId: String(runRec.r.run_id),
    facts,
    startNs,
    endNs,
    steps: filled,
    workers,
    runAttrs,
    status: failed ? 2 : 0,
    ...(failed && finish?.r.message ? { message: String(finish.r.message).slice(0, 300) } : {}),
    finished: Boolean(finish),
  };
}

/**
 * The identity + VCS attributes every span carries, mirroring the Dash0 agent plugin.
 * @param {BuiltRun} run @param {NodeJS.ProcessEnv} env @returns {Record<string, any>}
 */
export function identityAttributes(run, env) {
  const f = run.facts;
  const [owner, name] = String(f.repo || "").split("/");
  const joined = Boolean(f.conversation_id);
  const harness = f.harness && (!PLUGIN_HARNESSES.has(f.harness) || joined) ? f.harness : null;
  const repoUrl = owner && name ? `https://github.com/${owner}/${name}` : null;
  return {
    "gen_ai.agent.name": AGENT_NAME,
    "gen_ai.conversation.id": f.conversation_id || run.runId,
    "gen_ai.harness.name": harness,
    "gen_ai.provider.name": providerForModel(f.model),
    "gen_ai.request.model": f.model || null,
    "dash0.gen_ai.vcs.repository.url.full": repoUrl,
    "dash0.gen_ai.vcs.repository.name": name || null,
    "dash0.gen_ai.vcs.owner.name": owner || null,
    "dash0.gen_ai.vcs.provider.name": repoUrl ? "github" : null,
    "dash0.gen_ai.vcs.ref.head.name": f.head_ref || null,
    "dash0.gen_ai.vcs.ref.head.type": f.head_ref ? "branch" : null,
    "dash0.gen_ai.vcs.ref.head.revision": f.head_sha || null,
    "dash0.gen_ai.vcs.pull_request.url": repoUrl && f.number ? `${repoUrl}/pull/${f.number}` : null,
    "dash0.team.name": env.PR_REVIEWER_TEAM_NAME || null,
    "user.name": f.user_name || null,
    "dash0.gen_ai.user.identity.source": f.user_name ? "git" : null,
  };
}

/** Prefix a free attribute bag into the pr_review.* namespace, so a marker can never overwrite a
 *  gen_ai.* or VCS key. @param {Record<string, any>} bag @returns {Record<string, any>} */
function ns(bag) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const [k, v] of Object.entries(bag || {})) {
    if (v === undefined || v === null || v === "") continue;
    out[k.startsWith("pr_review.") ? k : `pr_review.${k}`] = v;
  }
  return out;
}

/**
 * The exporter for a built run: the trace (root + steps + workers) and two low-cardinality
 * histograms. Returns the exporter unflushed.
 * @param {BuiltRun} run @param {NodeJS.ProcessEnv} env
 */
export function toExporter(run, env) {
  const { endpoint, headers } = exportTarget(env);
  const f = run.facts;
  const ex = new OtlpExporter({
    endpoint,
    headers,
    scopeName: SCOPE_NAME,
    scopeVersion: f.version || "1",
    histBounds: HIST_BOUNDS,
    resource: {
      "service.name": env.OTEL_SERVICE_NAME || AGENT_NAME,
      "service.namespace": "agent-skills",
      "service.version": f.version || null,
      "gen_ai.agent.name": AGENT_NAME,
      "gen_ai.harness.name": identityAttributes(run, env)["gen_ai.harness.name"],
    },
  });
  ex.traceId = traceIdFor(run.runId);
  const identity = identityAttributes(run, env);
  const rootId = spanIdFor(run.runId, "root");
  ex.spans.push({
    traceId: ex.traceId,
    spanId: rootId,
    name: `invoke_agent ${AGENT_NAME}`,
    kind: 1,
    startTimeUnixNano: String(run.startNs),
    endTimeUnixNano: String(run.endNs),
    attributes: attrs({
      ...identity,
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.id": run.runId,
      ...ns({
        mode: f.mode, tier: f.tier, thoroughness: f.thoroughness, topology: f.topology,
        "pr.number": f.number, ...run.runAttrs,
      }),
      ...(run.status === 2 ? { "error.type": "review_failed" } : {}),
    }),
    status: run.status === 2 ? { code: 2, message: run.message || "review failed" } : { code: 0 },
  });
  run.steps.forEach((s, i) => {
    ex.spans.push({
      traceId: ex.traceId,
      spanId: spanIdFor(run.runId, `step:${i}:${s.name}`),
      parentSpanId: rootId,
      name: `pr_review.step ${s.name}`,
      kind: 1,
      startTimeUnixNano: String(s.startNs),
      endTimeUnixNano: String(s.endNs),
      attributes: attrs({ ...identity, "pr_review.step.name": s.name, "pr_review.step.kind": s.kind, "pr_review.step.marked": s.marked, ...ns(s.attrs) }),
      status: { code: 0 },
    });
    ex.histogram("pr_review.step.duration", Number(s.endNs - s.startNs) / 1e9,
      { "pr_review.step.name": s.name, "pr_review.step.kind": s.kind, "gen_ai.agent.name": AGENT_NAME }, "s");
  });
  run.workers.forEach((w, i) => {
    ex.spans.push({
      traceId: ex.traceId,
      spanId: spanIdFor(run.runId, `worker:${i}:${w.unit}`),
      parentSpanId: rootId,
      name: `pr_review.worker ${w.unit}`,
      kind: 1,
      startTimeUnixNano: String(w.startNs),
      endTimeUnixNano: String(w.endNs),
      attributes: attrs({ ...identity, "pr_review.worker.unit": w.unit, ...ns(w.attrs) }),
      status: { code: 0 },
    });
  });
  ex.histogram("pr_review.run.duration", Number(run.endNs - run.startNs) / 1e9, {
    "gen_ai.agent.name": AGENT_NAME,
    "pr_review.tier": f.tier, "pr_review.topology": f.topology,
    "pr_review.verdict": run.runAttrs.verdict,
  }, "s");
  return ex;
}

/**
 * The per-step breakdown — written to SUMMARY_FILE on every finish, endpoint or not.
 * @param {BuiltRun} run
 */
export function summarize(run) {
  const total = Number(run.endNs - run.startNs) / 1e9;
  const round = (/** @type {number} */ n) => Math.round(n * 10) / 10;
  return {
    run_id: run.runId,
    trace_id: traceIdFor(run.runId),
    total_s: round(total),
    steps: run.steps.map((s) => {
      const d = Number(s.endNs - s.startNs) / 1e9;
      return {
        name: s.name, kind: s.kind, marked: s.marked,
        start_offset_s: round(Number(s.startNs - run.startNs) / 1e9),
        duration_s: round(d),
        share: total > 0 ? Math.round((d / total) * 100) : 0,
      };
    }),
    workers: run.workers.map((w) => ({
      unit: w.unit,
      start_offset_s: round(Number(w.startNs - run.startNs) / 1e9),
      duration_s: round(Number(w.endNs - w.startNs) / 1e9),
    })),
  };
}

/** @param {ReturnType<typeof summarize>} s @returns {string} */
export function renderSummary(s) {
  const rows = s.steps.map((x) => `  ${x.name.padEnd(16)} ${x.kind.padEnd(8)} ${String(x.duration_s).padStart(7)}s ${String(x.share).padStart(4)}%`);
  const wrows = s.workers.map((w) => `  worker ${w.unit.padEnd(9)} ${"sub-agent".padEnd(8)} ${String(w.duration_s).padStart(7)}s  (from +${w.start_offset_s}s)`);
  return [`review ${s.run_id} · ${s.total_s}s · trace ${s.trace_id}`, ...rows, ...wrows].join("\n");
}

/**
 * Close the run and export it. Idempotent: a run already exported is not exported twice unless
 * `force`. Never throws.
 * @param {string} runDir @param {{ status?: string, message?: string, attrs?: Record<string, any>,
 *   force?: boolean }} [opts] @param {NodeJS.ProcessEnv} [env]
 */
export async function finishRun(runDir, opts = {}, env = process.env) {
  try {
    const summaryPath = join(runDir, SUMMARY_FILE);
    if (!opts.force && existsSync(summaryPath)) {
      const prev = JSON.parse(readFileSync(summaryPath, "utf8"));
      if (prev && prev.exported === true) return { ...prev, skipped: "already exported" };
    }
    const records = readLedger(runDir);
    if (!records.some((r) => r.t === "run")) return { exported: false, reason: `no run in ${ledgerPath(runDir)}` };
    if (!records.some((r) => r.t === "finish")) {
      appendRecord(runDir, { t: "finish", status: opts.status === "error" ? "error" : "ok", ...(opts.message ? { message: opts.message } : {}), attrs: opts.attrs || {} });
    } else if (opts.attrs && Object.keys(opts.attrs).length) {
      appendRecord(runDir, { t: "attr", target: "run", attrs: opts.attrs });
    }
    const run = buildRun(readLedger(runDir));
    if (!run) return { exported: false, reason: "ledger has no run" };
    const summary = summarize(run);
    const ex = toExporter(run, env);
    const result = await ex.flush();
    const out = { ...summary, exported: result.exported, ...(result.reason ? { reason: result.reason } : {}) };
    writeFileSync(summaryPath, `${JSON.stringify(out, null, 2)}\n`, "utf8");
    return out;
  } catch (e) {
    return { exported: false, reason: `telemetry error: ${String(/** @type {Error} */ (e).message || e).slice(0, 200)}` };
  }
}

/**
 * The facts a script knows about the reviewer itself: its version and the git identity, the same
 * source the Dash0 agent plugin reads for `user.name`.
 * @param {NodeJS.ProcessEnv} env @returns {{ version?: string, user_name?: string, harness?: string,
 *   conversation_id?: string }}
 */
export function hostFacts(env = process.env) {
  /** @type {{ version?: string, user_name?: string, harness?: string, conversation_id?: string }} */
  const out = {};
  const here = dirname(fileURLToPath(import.meta.url));
  // The checkout this script runs from first; AGENT_SKILLS_COMMIT (the Agent0 setup script's pin)
  // only when that is not a git checkout — the two differ whenever a snapshot runs next to the
  // installed pin, and the running code is the one to report.
  const version = gitOut(["-C", here, "rev-parse", "--short", "HEAD"])
    || (env.AGENT_SKILLS_COMMIT ? env.AGENT_SKILLS_COMMIT.slice(0, 7) : "");
  if (version) out.version = version;
  if (String(env.PR_REVIEWER_OMIT_USER_INFO || "").toLowerCase() !== "true") {
    const user = gitOut(["config", "user.name"]);
    if (user) out.user_name = user;
  }
  const harness = detectHarness(env);
  if (harness) out.harness = harness;
  const conv = detectConversationId(env);
  if (conv) out.conversation_id = conv;
  return out;
}

/** @param {string[]} args @returns {string} */
function gitOut(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).trim();
  } catch {
    return "";
  }
}

/* ---------------------------------------- CLI ---------------------------------------- */

/** @param {string} v @returns {string|number|boolean} */
function typed(v) {
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

/** The value-taking flags. `flag(args, "<name>")` below is the one reader, so the flag contract is
 *  visible to L1 G43a (which extracts it from this file) and to a reader alike. */
const VALUE_FLAGS = ["run-dir", "repo", "pr", "head", "head-ref", "mode", "tier", "thoroughness", "topology",
  "model", "conversation-id", "harness", "target", "status", "message", "from", "done", "attr"];

/** @param {string[]} args @param {string} name @returns {string|undefined} */
function flag(args, name) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
}

/** @param {string[]} args */
function parseCli(args) {
  /** @type {Record<string, string|undefined>} */
  const opts = {
    "run-dir": flag(args, "run-dir"), repo: flag(args, "repo"), pr: flag(args, "pr"), head: flag(args, "head"),
    "head-ref": flag(args, "head-ref"), mode: flag(args, "mode"), tier: flag(args, "tier"),
    thoroughness: flag(args, "thoroughness"), topology: flag(args, "topology"), model: flag(args, "model"),
    "conversation-id": flag(args, "conversation-id"), harness: flag(args, "harness"), target: flag(args, "target"),
    status: flag(args, "status"), message: flag(args, "message"), from: flag(args, "from"), done: flag(args, "done"),
    force: args.includes("--force") ? "true" : undefined,
  };
  /** @type {Record<string, string|number|boolean>} */
  const attrBag = {};
  if (flag(args, "attr") !== undefined) {
    args.forEach((a, i) => {
      if (a !== "--attr") return;
      const kv = args[i + 1] || "";
      const j = kv.indexOf("=");
      if (j > 0 && /^[a-z][a-z0-9_.]*$/.test(kv.slice(0, j))) attrBag[kv.slice(0, j)] = typed(kv.slice(j + 1));
    });
  }
  /** @type {string[]} */
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) { if (VALUE_FLAGS.includes(a.slice(2))) i++; continue; }
    positional.push(a);
  }
  return { positional, opts, attrBag };
}

/** @param {string} msg */
function warn(msg) {
  process.stderr.write(`review-telemetry: ignored — ${msg}\n`);
}

/** @param {string[]} argv */
async function main(argv) {
  const { positional, opts, attrBag } = parseCli(argv);
  const cmd = positional[0];
  const runDir = opts["run-dir"] || process.env.PR_REVIEW_RUN_DIR || "";
  if (!cmd) { warn("no command (begin | step | end | attr | worker | finish | summary)"); return; }
  if (!runDir) { warn(`${cmd}: no --run-dir and no PR_REVIEW_RUN_DIR`); return; }
  try {
    if (cmd === "begin") {
      const facts = {
        ...hostFacts(),
        repo: opts.repo, number: opts.pr ? Number(opts.pr) : undefined, head_sha: opts.head, head_ref: opts["head-ref"],
        mode: opts.mode, tier: opts.tier, thoroughness: opts.thoroughness ? Number(opts.thoroughness) : undefined,
        topology: opts.topology, model: opts.model,
        ...(opts["conversation-id"] ? { conversation_id: opts["conversation-id"] } : {}),
        ...(opts.harness ? { harness: opts.harness } : {}),
      };
      const id = beginRun(runDir, facts);
      console.log(id);
      return;
    }
    if (!readLedger(runDir).some((r) => r.t === "run")) { warn(`${cmd}: no run started in ${runDir} (run \`begin\` first)`); return; }
    if (cmd === "step") {
      const name = positional[1] || "";
      if (!STEP_NAME_RE.test(name)) { warn(`step name ${JSON.stringify(name)} must match ${STEP_NAME_RE}`); return; }
      appendRecord(runDir, { t: "step", phase: "start", name, attrs: attrBag });
    } else if (cmd === "end") {
      appendRecord(runDir, { t: "step", phase: "end", ...(positional[1] ? { name: positional[1] } : {}), attrs: attrBag });
    } else if (cmd === "attr") {
      appendRecord(runDir, { t: "attr", target: opts.target === "step" ? "step" : "run", attrs: attrBag });
    } else if (cmd === "worker") {
      const unit = positional[1] || "";
      const phase = positional[2];
      if (!/^[a-z][a-z0-9@_-]{0,39}$/.test(unit) || !["start", "end", "import"].includes(String(phase))) { warn("usage: worker <unit> start|end|import"); return; }
      if (phase === "import") {
        // A worker that prepared its own context (the hybrid intent worker) kept its own ledger;
        // fold its span — first record to last — into this run as one worker span.
        const from = opts.from || "";
        const theirs = readLedger(from).map((r) => BigInt(r.ns));
        // A worker prepared with --no-telemetry keeps no ledger; its context.json still says when
        // it started (generatedAt − elapsedMs) and when its preparation ended.
        const ctxPath = join(from, "context.json");
        if (!theirs.length && existsSync(ctxPath)) {
          const ctx = JSON.parse(readFileSync(ctxPath, "utf8"));
          const doneMs = Date.parse(String(ctx.generatedAt || ""));
          if (Number.isFinite(doneMs)) {
            theirs.push(BigInt(Math.round(doneMs - (Number(ctx.elapsedMs) || 0))) * 1_000_000n, BigInt(doneMs) * 1_000_000n);
          }
        }
        if (!theirs.length) { warn(`worker ${unit} import: no ledger or context.json in ${JSON.stringify(from)}`); return; }
        const first = theirs.reduce((a, b) => (b < a ? b : a));
        const last = theirs.reduce((a, b) => (b > a ? b : a));
        const donePath = opts.done || "";
        const doneAt = donePath && existsSync(donePath) ? BigInt(Math.round(statSync(donePath).mtimeMs)) * 1_000_000n : last;
        appendRecord(runDir, { t: "worker", unit, phase: "start", ns: first, attrs: attrBag });
        appendRecord(runDir, { t: "worker", unit, phase: "end", ns: doneAt > last ? doneAt : last });
        return;
      }
      appendRecord(runDir, { t: "worker", unit, phase, attrs: attrBag });
    } else if (cmd === "finish") {
      const out = await finishRun(runDir, { status: opts.status, message: opts.message, attrs: attrBag, force: opts.force === "true" });
      if ("steps" in out) process.stderr.write(`${renderSummary(/** @type {any} */ (out))}\n`);
      process.stderr.write(`review-telemetry: ${out.exported ? "exported" : `not exported (${out.reason || out.skipped || "?"})`}\n`);
    } else if (cmd === "summary") {
      const run = buildRun(readLedger(runDir));
      if (run) console.log(renderSummary(summarize(run)));
    } else {
      warn(`unknown command ${JSON.stringify(cmd)}`);
    }
  } catch (e) {
    warn(`${cmd}: ${String(/** @type {Error} */ (e).message || e).slice(0, 200)}`);
  }
}

/* ------------------------------------- self-test ------------------------------------- */

async function selfTest() {
  /** @type {string[]} */
  const fails = [];
  let passed = 0;
  /** @param {string} label @param {boolean} cond @param {string} [detail] */
  const ok = (label, cond, detail = "") => {
    if (cond) { passed++; console.log(`  ✓ ${label}`); } else { fails.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
  };
  const S = 1_000_000_000n;
  const t0 = 1_790_000_000n * S;
  /** @param {number} sec @param {Record<string, any>} rec */
  const at = (sec, rec) => ({ ns: String(t0 + BigInt(sec) * S), ...rec });
  const facts = { repo: "mthines/sync-tray", number: 72, head_sha: "bfd6662", head_ref: "fix/x", mode: "full", tier: "deep", thoroughness: 0.8, topology: "hybrid" };

  // Timing — unchanged contract.
  const timing = new Timing();
  timing.start("prepare"); timing.end();
  ok("Timing block has phases + total_ms", typeof timing.block().total_ms === "number" && typeof timing.block().phases.prepare === "number");

  // buildRun: marked steps, a gap, a worker, attrs, finish.
  const ledger = [
    at(0, { t: "run", run_id: "r1", facts }),
    at(0, { t: "step", phase: "start", name: "prepare" }),
    at(10, { t: "step", phase: "end", attrs: { "phase.impact_ms": 900 } }),
    at(12, { t: "worker", unit: "intent", phase: "start" }),
    at(20, { t: "step", phase: "start", name: "finders" }),
    at(80, { t: "step", phase: "start", name: "verify", attrs: { candidates: 0 } }),
    at(95, { t: "worker", unit: "intent", phase: "end", attrs: { candidates: 19 } }),
    at(100, { t: "step", phase: "start", name: "finalize" }),
    at(110, { t: "attr", target: "run", attrs: { verdict: "FAIL", posted_inline: 9 } }),
    at(110, { t: "finish", status: "ok" }),
  ];
  const run = /** @type {BuiltRun} */ (buildRun(/** @type {any} */ (ledger)));
  ok("buildRun reads the run", run !== null && run.runId === "r1" && run.finished);
  const names = run.steps.map((s) => s.name);
  ok("steps in order, the 10–20 s gap filled as `unmarked`",
    JSON.stringify(names) === JSON.stringify(["prepare", "unmarked", "finders", "verify", "finalize"]), names.join(","));
  const sum = run.steps.reduce((n, s) => n + Number(s.endNs - s.startNs), 0) / 1e9;
  ok("the steps add up to the run (110 s)", sum === 110, String(sum));
  ok("a step started while another is open closes the open one at that moment",
    Number(run.steps[2].endNs - run.steps[2].startNs) / 1e9 === 60);
  ok("the worker spans its own start and end", run.workers.length === 1 && Number(run.workers[0].endNs - run.workers[0].startNs) / 1e9 === 83);
  ok("step kinds come from the vocabulary", run.steps[0].kind === "script" && run.steps[2].kind === "model" && run.steps[1].marked === false);

  // The exported trace, against the Dash0 agent plugin's contract.
  const env = { PR_REVIEWER_OTLP_ENDPOINT: "https://ingress.example.com" };
  const ex = toExporter(run, env);
  const payload = /** @type {any} */ (ex.tracePayload());
  const spans = payload.resourceSpans[0].scopeSpans[0].spans;
  const get = (/** @type {any} */ s, /** @type {string} */ k) => {
    const a = s.attributes.find((/** @type {any} */ x) => x.key === k);
    return a ? (a.value.stringValue ?? a.value.intValue ?? a.value.doubleValue ?? a.value.boolValue) : undefined;
  };
  const root = spans[0];
  ok("root span is `invoke_agent pr-reviewer`, operation invoke_agent, agent id = run id",
    root.name === "invoke_agent pr-reviewer" && get(root, "gen_ai.operation.name") === "invoke_agent" && get(root, "gen_ai.agent.id") === "r1");
  ok("no span is a `chat` or `execute_tool` span (the plugin owns those; no double counting)",
    spans.every((/** @type {any} */ s) => !/^(chat|execute_tool)\b/.test(s.name) && !["chat", "execute_tool"].includes(get(s, "gen_ai.operation.name"))));
  ok("only the root carries gen_ai.operation.name", spans.filter((/** @type {any} */ s) => get(s, "gen_ai.operation.name") !== undefined).length === 1);
  ok("every span carries the identity and VCS keys the plugin puts on every span",
    spans.every((/** @type {any} */ s) => get(s, "gen_ai.agent.name") === "pr-reviewer" && get(s, "gen_ai.conversation.id") === "r1"
      && get(s, "dash0.gen_ai.vcs.repository.name") === "sync-tray" && get(s, "dash0.gen_ai.vcs.owner.name") === "mthines"
      && get(s, "dash0.gen_ai.vcs.pull_request.url") === "https://github.com/mthines/sync-tray/pull/72"
      && get(s, "dash0.gen_ai.vcs.ref.head.revision") === "bfd6662"));
  ok("every child parents the root, in one deterministic trace",
    spans.slice(1).every((/** @type {any} */ s) => s.parentSpanId === root.spanId && s.traceId === root.traceId) && root.traceId === traceIdFor("r1"));
  const badKeys = spans.flatMap((/** @type {any} */ s) => s.attributes.map((/** @type {any} */ a) => a.key)).filter((/** @type {string} */ k) => !ALLOWED_SPAN_KEY(k));
  ok("every attribute key is in the declared contract", badKeys.length === 0, [...new Set(badKeys)].join(","));
  const verifySpan = spans.find((/** @type {any} */ s) => s.name === "pr_review.step verify");
  ok("rule 2 — a step that found nothing stays UNSET", verifySpan?.status.code === 0 && get(verifySpan, "pr_review.candidates") === "0");
  ok("marker attributes are namespaced under pr_review.* on the root",
    get(root, "pr_review.verdict") === "FAIL" && get(root, "pr_review.posted_inline") === "9");
  ok("rule 3 — an unknown model emits no gen_ai.request.model or provider, never a placeholder",
    get(root, "gen_ai.request.model") === undefined && get(root, "gen_ai.provider.name") === undefined);
  const metrics = /** @type {any} */ (ex.metricPayload()).resourceMetrics[0].scopeMetrics[0].metrics;
  const stepHist = metrics.filter((/** @type {any} */ m) => m.name === "pr_review.step.duration");
  ok("one pr_review.step.duration series per step name, keyed by step and kind only (no run id)",
    stepHist.length === 5 && stepHist.every((/** @type {any} */ m) => m.histogram.dataPoints[0].attributes.every((/** @type {any} */ a) => ["pr_review.step.name", "pr_review.step.kind", "gen_ai.agent.name"].includes(a.key))));

  // The harness rule.
  const withHarness = (/** @type {RunFacts} */ extra) => identityAttributes({ ...run, facts: { ...facts, ...extra } }, {})["gen_ai.harness.name"];
  ok("inside a plugin-covered harness with no joined session, no gen_ai.harness.name (no phantom session)",
    withHarness({ harness: "claude-code" }) === null);
  ok("joined to the harness session through gen_ai.conversation.id, the harness is named",
    withHarness({ harness: "claude-code", conversation_id: "sess-1" }) === "claude-code");
  ok("a harness the plugin does not cover (agent0, CI) is always named", withHarness({ harness: "agent0" }) === "agent0");
  ok("providerForModel follows the plugin's mapping",
    providerForModel("claude-opus-5-5") === "anthropic" && providerForModel("o3") === "openai" && providerForModel("gemini-2") === "gcp.gemini" && providerForModel("x") === null);
  ok("parseHeaders decodes percent-encoded values (the OTel spec form)",
    parseHeaders("Authorization=Bearer%20abc,Dash0-Dataset=default").Authorization === "Bearer abc");
  ok("rule 1 — a host's OTEL_EXPORTER_OTLP_ENDPOINT alone is never used (opt-in only)",
    exportTarget({ OTEL_EXPORTER_OTLP_ENDPOINT: "https://host", OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer x" }).endpoint === "");
  ok("PR_REVIEWER_TELEMETRY=on reuses the standard OTEL_* variables",
    exportTarget({ PR_REVIEWER_TELEMETRY: "on", OTEL_EXPORTER_OTLP_ENDPOINT: "https://host", OTEL_EXPORTER_OTLP_HEADERS: "Dash0-Dataset=d" }).headers["Dash0-Dataset"] === "d");
  ok("PR_REVIEWER_TELEMETRY=off disables export even with an endpoint",
    exportTarget({ PR_REVIEWER_TELEMETRY: "off", PR_REVIEWER_OTLP_ENDPOINT: "https://x" }).endpoint === "");
  ok("PR_REVIEWER_OTLP_ENDPOINT wins over the host's OTEL_EXPORTER_OTLP_ENDPOINT",
    exportTarget({ PR_REVIEWER_TELEMETRY: "on", PR_REVIEWER_OTLP_ENDPOINT: "https://mine", OTEL_EXPORTER_OTLP_ENDPOINT: "https://host" }).endpoint === "https://mine");

  // The ledger on disk, end to end through a real OTLP receiver.
  const dir = mkdtempSync(join(tmpdir(), "review-telemetry-"));
  /** @type {Array<{ path: string, body: any }>} */
  const received = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      try { received.push({ path: String(req.url), body: JSON.parse(body) }); } catch { received.push({ path: String(req.url), body: null }); }
      res.writeHead(200, { "content-type": "application/json" }); res.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(null)));
  const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
  try {
    const runDir = join(dir, "run");
    const id1 = beginRun(runDir, facts);
    const id2 = beginRun(runDir, { model: "claude-opus-5-5" });
    ok("begin is idempotent: a second begin adds facts to the same run", id1 === id2 && readLedger(runDir).filter((r) => r.t === "run").length === 1);
    appendRecord(runDir, { t: "step", phase: "start", name: "prepare" });
    appendRecord(runDir, { t: "step", phase: "end" });
    const otherDir = join(dir, "shared");
    const a = beginRun(otherDir, facts);
    const b = beginRun(otherDir, { ...facts, number: 73 });
    ok("a begin for another PR in the same directory rotates the old ledger, never merges into it",
      a !== b && existsSync(join(otherDir, `telemetry.${a}.jsonl`)) && readLedger(otherDir).filter((r) => r.t === "run").length === 1);
    appendFileSync(ledgerPath(runDir), "{torn line\n");
    ok("a torn ledger line is skipped, never fatal", readLedger(runDir).length === 4);
    const off = await finishRun(runDir, {}, {});
    ok("rule 1 — no endpoint: nothing exported, but the summary is written", off.exported === false && existsSync(join(runDir, SUMMARY_FILE)));
    const on = await finishRun(runDir, { force: true, attrs: { verdict: "PASS" } }, { PR_REVIEWER_OTLP_ENDPOINT: `http://127.0.0.1:${port}` });
    ok("with an endpoint: exported to /v1/traces and /v1/metrics", on.exported === true
      && received.some((r) => r.path === "/v1/traces") && received.some((r) => r.path === "/v1/metrics"));
    const tr = received.find((r) => r.path === "/v1/traces")?.body;
    const rootSpan = tr?.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0];
    ok("the received trace's root carries the model's provider once `begin` supplied the model",
      rootSpan?.name === "invoke_agent pr-reviewer" && get(rootSpan, "gen_ai.provider.name") === "anthropic" && get(rootSpan, "gen_ai.request.model") === "claude-opus-5-5");
    const before = received.length;
    const again = await finishRun(runDir, {}, { PR_REVIEWER_OTLP_ENDPOINT: `http://127.0.0.1:${port}` });
    ok("finish is idempotent: an exported run is not exported twice", received.length === before && again.skipped === "already exported");
    const deadDir = join(dir, "dead");
    beginRun(deadDir, facts);
    const dead = await finishRun(deadDir, {}, { PR_REVIEWER_OTLP_ENDPOINT: "http://127.0.0.1:1" });
    ok("rule 4 — an unreachable backend is exported:false, never a throw", dead.exported === false);
    const errDir = join(dir, "err");
    beginRun(errDir, facts);
    await finishRun(errDir, { status: "error", message: "finalize exited 1" }, {});
    const errRun = /** @type {BuiltRun} */ (buildRun(readLedger(errDir)));
    ok("a failed run marks the root ERROR with its message", errRun.status === 2 && errRun.message === "finalize exited 1");

    // CLI: a misuse never fails the command it is chained in front of (rule 4).
    const self = fileURLToPath(import.meta.url);
    const { spawnSync } = await import("node:child_process");
    const cliDir = join(dir, "cli");
    const r1 = spawnSync(process.execPath, [self, "step", "Bad Name", "--run-dir", cliDir], { encoding: "utf8" });
    ok("CLI: a bad step name exits 0 with a warning", r1.status === 0 && /ignored/.test(r1.stderr));
    spawnSync(process.execPath, [self, "begin", "--run-dir", cliDir, "--repo", "o/r", "--pr", "3"], { encoding: "utf8", env: { ...process.env, PR_REVIEWER_TELEMETRY: "off" } });
    spawnSync(process.execPath, [self, "step", "finders", "--run-dir", cliDir, "--attr", "candidates=4"], { encoding: "utf8" });
    const r2 = spawnSync(process.execPath, [self, "finish", "--run-dir", cliDir], { encoding: "utf8", env: { ...process.env, PR_REVIEWER_TELEMETRY: "off" } });
    const cliSummary = JSON.parse(readFileSync(join(cliDir, SUMMARY_FILE), "utf8"));
    ok("CLI: begin → step → finish writes a summary with the marked step", r2.status === 0
      && cliSummary.steps.some((/** @type {any} */ s) => s.name === "finders" && s.marked === true));
    const workerDir = join(dir, "intent");
    mkdirSync(workerDir, { recursive: true });
    const doneAt = Date.now() - 5000;
    writeFileSync(join(workerDir, "context.json"), JSON.stringify({ generatedAt: new Date(doneAt).toISOString(), elapsedMs: 9000 }));
    writeFileSync(join(workerDir, "intent.json"), "[]");
    const impDir = join(dir, "imp");
    beginRun(impDir, facts);
    spawnSync(process.execPath, [self, "worker", "intent", "import", "--from", workerDir, "--done", join(workerDir, "intent.json"), "--run-dir", impDir], { encoding: "utf8" });
    const imported = readLedger(impDir).filter((r) => r.t === "worker");
    ok("CLI: worker import reads a --no-telemetry worker's span from its context.json and output file",
      imported.length === 2 && BigInt(imported[0].ns) === BigInt(doneAt - 9000) * 1_000_000n && BigInt(imported[1].ns) > BigInt(doneAt) * 1_000_000n);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`review-telemetry self-test: ${passed}/${passed + fails.length}`);
  return fails;
}

const isEntryPoint = process.argv[1] && process.argv[1].endsWith("review-telemetry.mjs");
if (isEntryPoint) {
  if (process.argv.includes("--self-test")) {
    const fails = await selfTest();
    console.log(`${fails.length === 0 ? "✓" : "✗"} review-telemetry self-test: ${fails.length === 0 ? "all checks passed" : `${fails.length} failed`}`);
    process.exit(fails.length === 0 ? 0 : 1);
  }
  await main(process.argv.slice(2));
}
