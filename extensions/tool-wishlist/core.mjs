import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { normalizeCapability, validateCapabilityRegistry } from "./registry.mjs";

export { normalizeCapability } from "./registry.mjs";

const MAX_EVENT_FILE_BYTES = 5 * 1024 * 1024;
const MAX_DECISION_FILE_BYTES = 1024 * 1024;
const IMPACT_WEIGHT = { minor: 1, degraded: 2, blocked: 4 };
const COLLECTION_MODES = new Set(["on", "off"]);
const STATE_ACTIONS = new Set(["select", "decline", "retire", "reopen"]);
const DECISION_ACTIONS = new Set([...STATE_ACTIONS, "merge", "unmerge"]);
export const WISHLIST_FILENAMES = {
  events: "tool-wishlist-events.jsonl",
  decisions: "tool-wishlist-decisions.jsonl",
  config: "tool-wishlist-config.json",
  report: "TOOL_WISHLIST.md",
  salt: ".tool-wishlist-salt",
  lock: ".tool-wishlist.lock",
  archives: "tool-wishlist-archives",
  archiveTransaction: ".tool-wishlist-archive-transaction.json",
};

function compactText(value, maxLength) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function readCapabilityRegistry() {
  const file = fileURLToPath(new URL("./capabilities.json", import.meta.url));
  const registry = validateCapabilityRegistry(JSON.parse(fs.readFileSync(file, "utf8")));
  return Object.freeze({
    schema: 1,
    capabilities: Object.freeze(registry.capabilities.map((item) => Object.freeze({
      ...item,
      aliases: Object.freeze([...item.aliases]),
      validations: Object.freeze([...item.validations]),
    }))),
  });
}

export const CAPABILITY_REGISTRY = readCapabilityRegistry();

function registryAliasMap() {
  const aliases = new Map();
  for (const item of CAPABILITY_REGISTRY.capabilities) {
    for (const alias of item.aliases) aliases.set(alias, item.id);
  }
  return aliases;
}

function registryCapability(value) {
  const key = normalizeCapability(value);
  const aliases = registryAliasMap();
  const canonical = aliases.get(key) ?? key;
  return CAPABILITY_REGISTRY.capabilities.find((item) => item.id === canonical);
}

export function isImplementedCapability(value) {
  return Boolean(registryCapability(value));
}

function pathsFor(stateDir) {
  return Object.fromEntries(Object.entries(WISHLIST_FILENAMES).map(([key, file]) => [key, path.join(stateDir, file)]));
}

function fileHash(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function recoverArchiveTransaction(stateDir) {
  const files = pathsFor(stateDir);
  if (!fs.existsSync(files.archiveTransaction)) return;
  assertNotSymlink(files.archiveTransaction);
  const transaction = JSON.parse(fs.readFileSync(files.archiveTransaction, "utf8"));
  if (transaction?.schema !== 1 || typeof transaction.archiveDir !== "string" || !Array.isArray(transaction.files)) {
    throw new Error("Invalid wishlist archive transaction; active state was not changed");
  }
  for (const item of transaction.files) {
    const archived = path.join(transaction.archiveDir, item.name);
    if (!fs.existsSync(archived) || fileHash(archived) !== item.sha256) {
      throw new Error("Wishlist archive transaction cannot be recovered because its prepared snapshot is incomplete");
    }
  }
  atomicWrite(files.events, "", 0o600);
  atomicWrite(files.decisions, "", 0o600);
  writeReport(files.report, [], [], 0, 0, transaction.timestamp);
  fs.rmSync(files.archiveTransaction, { force: true });
}

function assertNotSymlink(file) {
  try {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`Refusing to use symlinked wishlist state: ${file}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function atomicWrite(file, content, mode = 0o600) {
  assertNotSymlink(file);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temporary, content, { mode });
    fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Cancelled"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Cancelled"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function removeEmptyLockDirectory(lock) {
  try {
    fs.rmdirSync(lock);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
  }
}

function releaseOwnedLock(lock, marker) {
  try {
    fs.unlinkSync(marker);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  removeEmptyLockDirectory(lock);
}

async function withStateLock(stateDir, signal, operation) {
  const { lock } = pathsFor(stateDir);
  const token = `${process.pid}-${randomUUID()}`;
  const marker = path.join(lock, token);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      await delay(20 + attempt * 5, signal);
      continue;
    }
    let markerWritten = false;
    try {
      fs.writeFileSync(marker, "owned\n", { flag: "wx", mode: 0o600 });
      markerWritten = true;
      recoverArchiveTransaction(stateDir);
      return await operation();
    } finally {
      if (markerWritten) releaseOwnedLock(lock, marker);
      else removeEmptyLockDirectory(lock);
    }
  }
  throw new Error(`Timed out waiting for ${lock}. Remove it only after confirming no Pi session is updating the wishlist.`);
}

function isStoredEvent(event) {
  return (
    event?.schema === 1 && typeof event.timestamp === "string" && Number.isFinite(Date.parse(event.timestamp)) &&
    typeof event.canonicalKey === "string" &&
    (event.observedKey === undefined || typeof event.observedKey === "string") &&
    typeof event.sessionHash === "string" &&
    typeof event.runHash === "string" && typeof event.projectHash === "string" &&
    typeof event.capability === "string" && typeof event.scenario === "string" &&
    typeof event.limitation === "string" && Object.hasOwn(IMPACT_WEIGHT, event.impact) &&
    typeof event.workaround === "string" &&
    ["tool", "skill", "prompt", "config", "bug", "unknown"].includes(event.suggestedFix) &&
    (event.regression === undefined || typeof event.regression === "boolean")
  );
}

function isStoredDecision(event) {
  return (
    event?.schema === 1 && typeof event.id === "string" &&
    typeof event.timestamp === "string" && Number.isFinite(Date.parse(event.timestamp)) &&
    DECISION_ACTIONS.has(event.action) && typeof event.canonicalKey === "string" &&
    typeof event.targetKey === "string" && typeof event.reverses === "string" &&
    typeof event.note === "string"
  );
}

function readJsonLines(file, validator) {
  if (!fs.existsSync(file)) return { entries: [], invalidLines: 0, bytes: 0 };
  assertNotSymlink(file);
  const stat = fs.statSync(file);
  const entries = [];
  let invalidLines = 0;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (validator(entry)) entries.push(entry);
      else invalidLines += 1;
    } catch {
      invalidLines += 1;
    }
  }
  return { entries, invalidLines, bytes: stat.size };
}

export function readEventsFile(file) {
  const parsed = readJsonLines(file, isStoredEvent);
  return { events: parsed.entries, invalidLines: parsed.invalidLines, bytes: parsed.bytes };
}

export function readDecisionsFile(file) {
  const parsed = readJsonLines(file, isStoredDecision);
  return { decisions: parsed.entries, invalidLines: parsed.invalidLines, bytes: parsed.bytes };
}

function getSalt(file) {
  assertNotSymlink(file);
  if (fs.existsSync(file)) {
    const salt = fs.readFileSync(file, "utf8").trim();
    if (salt) return salt;
  }
  const salt = randomBytes(32).toString("hex");
  atomicWrite(file, `${salt}\n`, 0o600);
  return salt;
}

function privateHash(salt, value) {
  return createHash("sha256").update(salt).update("\0").update(String(value)).digest("hex").slice(0, 20);
}

function sanitizeReportText(value, maxLength) {
  const sanitized = compactText(value, maxLength * 2)
    .replace(/https?:\/\/\S+/gi, "[url omitted]")
    .replace(/\b(?:authorization\s*:\s*)?bearer\s+\S+/gi, "[credential omitted]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\b/g, "[credential omitted]")
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs]|AKIA)[-_A-Za-z0-9]{8,}\b/g, "[credential omitted]")
    .replace(/\b(?:api[_ -]?key|access[_ -]?token|password|secret)\s*[:=]\s*\S+/gi, "[credential omitted]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----.*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gi, "[credential omitted]")
    .replace(/(^|[\s([{'\"])(?:~\/|\.{0,2}\/|\/[A-Za-z0-9._-])\S*/g, "$1[path omitted]")
    .replace(/\b(?:[A-Za-z0-9._-]+\/)+(?:[A-Za-z0-9._-]+\.(?:c|cc|cpp|css|go|h|hpp|html|java|js|json|jsx|md|mjs|py|rb|rs|sh|sql|ts|tsx|yaml|yml))\b/gi, "[path omitted]")
    .replace(/\b[A-Za-z]:\\\S+/g, "[path omitted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
  const forbidden = [
    /\b(?:authorization\s*:\s*)?bearer\s+\S+/i,
    /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\b/,
    /\b(?:sk|ghp|github_pat|xox[baprs]|AKIA)[-_A-Za-z0-9]{8,}\b/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  ];
  if (forbidden.some((pattern) => pattern.test(sanitized))) {
    throw new Error("Capability-gap report still appears to contain sensitive data after redaction");
  }
  return sanitized;
}

function sanitizeGap(gap) {
  const impact = Object.hasOwn(IMPACT_WEIGHT, gap.impact) ? gap.impact : "degraded";
  const allowedFixes = new Set(["tool", "skill", "prompt", "config", "bug", "unknown"]);
  return {
    capability: sanitizeReportText(gap.capability, 120),
    scenario: sanitizeReportText(gap.scenario, 300),
    limitation: sanitizeReportText(gap.limitation, 300),
    impact,
    workaround: sanitizeReportText(gap.workaround, 240),
    suggestedFix: allowedFixes.has(gap.suggestedFix) ? gap.suggestedFix : "unknown",
  };
}

function resolveAlias(key, aliases) {
  let current = normalizeCapability(key);
  const seen = new Set();
  while (aliases.has(current) && !seen.has(current)) {
    seen.add(current);
    current = aliases.get(current);
  }
  return current;
}

export function buildAliasMap(decisions = []) {
  const aliases = registryAliasMap();
  const reversed = new Set(decisions.filter((item) => item.action === "unmerge").map((item) => item.reverses));
  for (const decision of decisions) {
    if (decision.action === "merge" && !reversed.has(decision.id)) {
      aliases.set(decision.canonicalKey, decision.targetKey);
    }
  }
  for (const [key, target] of [...aliases]) aliases.set(key, resolveAlias(target, aliases));
  return aliases;
}

function canonicalizeEvents(events, decisions) {
  const aliases = buildAliasMap(decisions);
  return events.map((event) => ({
    ...event,
    canonicalKey: resolveAlias(event.observedKey ?? event.canonicalKey, aliases),
  }));
}

function lifecycleStates(decisions) {
  const aliases = buildAliasMap(decisions);
  const states = new Map();
  for (const item of CAPABILITY_REGISTRY.capabilities) states.set(item.id, "retired");
  for (const decision of decisions) {
    if (!STATE_ACTIONS.has(decision.action)) continue;
    const key = resolveAlias(decision.canonicalKey, aliases);
    states.set(key, decision.action === "select" ? "selected" : decision.action === "reopen" ? "open" : `${decision.action}d`);
  }
  return states;
}

function timestampMs(value) {
  return Date.parse(value);
}

function uniqueByRun(events) {
  const selected = new Map();
  for (const event of events) {
    const identity = `${event.canonicalKey}\0${event.runHash}`;
    const previous = selected.get(identity);
    if (
      !previous ||
      IMPACT_WEIGHT[event.impact] > IMPACT_WEIGHT[previous.impact] ||
      (IMPACT_WEIGHT[event.impact] === IMPACT_WEIGHT[previous.impact] && timestampMs(event.timestamp) > timestampMs(previous.timestamp))
    ) selected.set(identity, event);
  }
  return [...selected.values()];
}

function mostCommon(values) {
  const counts = new Map();
  for (const value of values.filter(Boolean)) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
}

export function aggregateEvents(events, options = {}) {
  const decisions = options.decisions ?? [];
  const groups = new Map();
  for (const event of uniqueByRun(canonicalizeEvents(events, decisions))) {
    const group = groups.get(event.canonicalKey) ?? [];
    group.push(event);
    groups.set(event.canonicalKey, group);
  }
  return [...groups.entries()]
    .map(([canonicalKey, items]) => {
      const ordered = [...items].sort((a, b) => timestampMs(a.timestamp) - timestampMs(b.timestamp));
      const highestImpact = [...ordered]
        .map((event) => event.impact)
        .sort((a, b) => IMPACT_WEIGHT[b] - IMPACT_WEIGHT[a])[0] ?? "minor";
      const distinct = (field) => new Set(ordered.map((event) => event[field]).filter(Boolean)).size;
      const recentUnique = (field) => {
        const values = [];
        for (const event of [...ordered].reverse()) {
          const value = event[field];
          if (value && !values.includes(value)) values.push(value);
          if (values.length === 3) break;
        }
        return values;
      };
      const priority = ordered.reduce((total, event) => total + (IMPACT_WEIGHT[event.impact] ?? 1), 0);
      return {
        canonicalKey,
        title: ordered.at(-1)?.capability ?? canonicalKey,
        occurrences: ordered.length,
        regressionOccurrences: ordered.filter((event) => event.regression).length,
        sessions: distinct("sessionHash"),
        projects: distinct("projectHash"),
        firstSeen: ordered[0]?.timestamp,
        lastSeen: ordered.at(-1)?.timestamp,
        impact: highestImpact,
        suggestedFix: mostCommon(ordered.map((event) => event.suggestedFix)) ?? "unknown",
        priority,
        qualified: priority >= IMPACT_WEIGHT.blocked || ordered.length >= 2,
        scenarios: recentUnique("scenario"),
        limitations: recentUnique("limitation"),
        workarounds: recentUnique("workaround"),
      };
    })
    .sort((a, b) =>
      b.priority - a.priority ||
      b.projects - a.projects ||
      b.sessions - a.sessions ||
      timestampMs(b.lastSeen) - timestampMs(a.lastSeen) ||
      a.canonicalKey.localeCompare(b.canonicalKey));
}

function latestRetirementTime(canonicalKey, decisions) {
  const aliases = buildAliasMap(decisions);
  let latest;
  for (const decision of decisions) {
    if (decision.action !== "retire" || resolveAlias(decision.canonicalKey, aliases) !== canonicalKey) continue;
    if (latest === undefined || timestampMs(decision.timestamp) > latest) latest = timestampMs(decision.timestamp);
  }
  return latest;
}

function reviewSignalCount(canonicalKey, events, decisions, state) {
  if (state !== "retired") return 0;
  const retirement = latestRetirementTime(canonicalKey, decisions);
  const projected = uniqueByRun(canonicalizeEvents(events, decisions)).filter((event) => event.canonicalKey === canonicalKey);
  if (retirement !== undefined) return projected.filter((event) => timestampMs(event.timestamp) > retirement).length;
  const registered = registryCapability(canonicalKey);
  return registered
    ? projected.filter((event) => timestampMs(event.timestamp) > timestampMs(registered.shippedAt)).length
    : 0;
}

function groupsWithState(events, decisions) {
  const states = lifecycleStates(decisions);
  return aggregateEvents(events, { decisions }).map((group) => {
    const state = states.get(group.canonicalKey) ?? "open";
    const signals = reviewSignalCount(group.canonicalKey, events, decisions, state);
    return { ...group, state, reviewNeeded: signals > 0, reviewSignalCount: signals };
  });
}

function queueGroups(events, decisions) {
  return groupsWithState(events, decisions).filter((group) => ["open", "selected"].includes(group.state));
}

export function nextWishlistCandidate(events, decisions = []) {
  const groups = queueGroups(events, decisions).filter((group) => group.qualified);
  return groups.find((group) => group.state === "selected") ?? groups.find((group) => group.state === "open");
}

function markdownText(value) {
  return compactText(value, 500).replace(/([\\`*_[\]<>#])/g, "\\$1");
}

function day(value) {
  return String(value ?? "").slice(0, 10) || "unknown";
}

function renderGroup(lines, group) {
  lines.push(
    "", `## ${markdownText(group.title)}`, "",
    `- ID: \`${group.canonicalKey}\``,
    `- Status: ${group.state}`,
    `- Qualified: ${group.qualified ? "yes" : "not yet"}`,
    `- Priority: **${group.priority}**`,
    `- Occurrences: ${group.occurrences}`,
    `- Distinct sessions: ${group.sessions}`,
    `- Distinct projects: ${group.projects}`,
    `- Impact: ${group.impact}`,
    `- Suggested fix: ${group.suggestedFix}`,
    `- First seen: ${day(group.firstSeen)}`,
    `- Last seen: ${day(group.lastSeen)}`,
  );
  if (group.reviewNeeded) lines.push(`- Review needed: yes`, `- Unresolved post-retirement signals: ${group.reviewSignalCount}`);
  if (group.scenarios.length) lines.push("", "**Observed needs**", ...group.scenarios.map((value) => `- ${markdownText(value)}`));
  if (group.limitations.length) lines.push("", "**Why current capabilities fell short**", ...group.limitations.map((value) => `- ${markdownText(value)}`));
  if (group.workarounds.length) lines.push("", "**Workarounds used**", ...group.workarounds.map((value) => `- ${markdownText(value)}`));
}

export function renderWishlist(events, options = {}) {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const decisions = options.decisions ?? [];
  const invalidLines = options.invalidLines ?? 0;
  const invalidDecisionLines = options.invalidDecisionLines ?? 0;
  const groups = groupsWithState(events, decisions);
  const queued = groups.filter((group) => ["open", "selected"].includes(group.state));
  const lines = [
    "# Tool Wishlist", "",
    "> Generated by ZenPi from privacy-minimized capability-gap reports and explicit local decisions. Do not edit this file directly.",
    "> Raw observations contain sanitized summaries and salted hashes. No data is uploaded.", "",
    `Generated: ${generatedAt}`,
    `Queued gaps: ${queued.length} | Recorded queue occurrences: ${queued.reduce((total, group) => total + group.occurrences, 0)}`, "",
    "Ranking uses a deterministic tuple: impact-weighted unique tasks, distinct projects, distinct sessions, recency, then ID.",
    "A gap qualifies after two unique tasks or one blocked-equivalent priority.",
  ];
  if (invalidLines > 0) lines.push(`Warning: ${invalidLines} malformed observation line(s) were ignored.`);
  if (invalidDecisionLines > 0) lines.push(`Warning: ${invalidDecisionLines} malformed decision line(s) were ignored.`);
  const sections = [
    ["Needs review", groups.filter((group) => group.reviewNeeded)],
    ["Selected", groups.filter((group) => group.state === "selected")],
    ["Open", groups.filter((group) => group.state === "open")],
    ["Declined", groups.filter((group) => group.state === "declined")],
  ];
  const reversedMerges = new Set(decisions.filter((item) => item.action === "unmerge").map((item) => item.reverses));
  const activeMerges = decisions.filter((item) => item.action === "merge" && !reversedMerges.has(item.id));
  if (groups.length === 0) {
    lines.push("", "No capability gaps have been recorded yet.", "");
    return lines.join("\n");
  }
  for (const [title, items] of sections) {
    if (items.length === 0) continue;
    lines.push("", `# ${title}`);
    for (const group of items) renderGroup(lines, group);
  }
  if (activeMerges.length > 0) {
    lines.push(
      "", "# Active aliases", "",
      ...activeMerges.map((item) => `- \`${item.canonicalKey}\` → \`${item.targetKey}\` (merge decision \`${item.id}\`)`),
      "", "Undo with `/wishlist unmerge <merge-decision-id>`.",
    );
  }
  const retired = groups.filter((group) => group.state === "retired" && !group.reviewNeeded);
  if (retired.length > 0) {
    lines.push("", "# Retired", "", ...retired.map((group) => `- \`${group.canonicalKey}\` — ${markdownText(group.title)}`));
  }
  lines.push("");
  return lines.join("\n");
}

function renderImprovementCard(group) {
  if (!group) return "# Next Improvement\n\nNo candidate is available.\n";
  const lines = [
    "# Next Improvement", "", `## ${markdownText(group.title)}`, "",
    `- ID: \`${group.canonicalKey}\``, `- Status: ${group.state}`,
    `- Evidence: ${group.occurrences} unique task(s), ${group.projects} project(s), ${group.sessions} session(s)`,
    `- Highest impact: ${group.impact}`, `- Smallest likely intervention: ${group.suggestedFix}`, "",
    "## Improvement card", "",
    `- **Observed need:** ${markdownText(group.scenarios[0] ?? "Describe the reusable need.")}`,
    `- **Current limitation:** ${markdownText(group.limitations[0] ?? "Describe why current capabilities fall short.")}`,
    "- **Hypothesis:** Define the smallest change expected to remove this friction.",
    "- **Acceptance check:** Define direct evidence that the capability works.",
    "- **Rollback:** Define how to reverse the change without losing observations.",
    "- **Privacy/security:** Confirm the change adds no unapproved collection, credentials, or remote state.", "",
    group.state === "selected"
      ? "This gap is selected. Load the `zenpi-improve` skill to prepare an approval-gated implementation proposal."
      : `Select explicitly with \`/wishlist select ${group.canonicalKey}\`. Selection never edits source or installs anything.`,
    "",
  ];
  return lines.join("\n");
}

export function renderNextWishlist(events, decisions = []) {
  const groups = groupsWithState(events, decisions);
  const candidate = nextWishlistCandidate(events, decisions);
  const enriched = candidate ? groups.find((group) => group.canonicalKey === candidate.canonicalKey) : undefined;
  return renderImprovementCard(enriched);
}

export function renderIssueDraft(events, decisions, requestedKey) {
  const aliases = buildAliasMap(decisions);
  const key = resolveAlias(requestedKey, aliases);
  const group = groupsWithState(events, decisions).find((item) => item.canonicalKey === key);
  if (!group) throw new Error(`Unknown wishlist gap: ${key}`);
  const lines = [
    `# Capability gap: ${markdownText(group.title)}`, "",
    "> Local draft only. Review before copying it anywhere; ZenPi does not upload or open an issue.", "",
    `**Gap ID:** \`${group.canonicalKey}\``,
    `**Evidence:** ${group.occurrences} unique task(s) across ${group.projects} project(s) and ${group.sessions} session(s)`,
    `**Impact:** ${group.impact}`, `**Suggested intervention:** ${group.suggestedFix}`, "",
    "## Observed needs", ...group.scenarios.map((value) => `- ${markdownText(value)}`), "",
    "## Current limitations", ...group.limitations.map((value) => `- ${markdownText(value)}`),
  ];
  if (group.workarounds.length) lines.push("", "## Workarounds", ...group.workarounds.map((value) => `- ${markdownText(value)}`));
  lines.push("", "## Acceptance", "- [ ] Define and run a direct capability check.", "- [ ] Confirm rollback behavior.", "- [ ] Confirm no prompts, source, credentials, commands, paths, or private identities are included.", "");
  return lines.join("\n");
}

function writeReport(reportPath, events, decisions, invalidLines, invalidDecisionLines, generatedAt) {
  const report = renderWishlist(events, { decisions, invalidLines, invalidDecisionLines, generatedAt });
  atomicWrite(reportPath, report, 0o600);
  return report;
}

function appendBounded(file, entry, currentBytes, maxBytes, label) {
  assertNotSymlink(file);
  const encoded = `${JSON.stringify(entry)}\n`;
  if (currentBytes + Buffer.byteLength(encoded, "utf8") > maxBytes) {
    throw new Error(`${label} reached its ${maxBytes}-byte limit. Archive the wishlist before adding more state.`);
  }
  fs.appendFileSync(file, encoded, { encoding: "utf8", mode: 0o600 });
  return currentBytes + Buffer.byteLength(encoded, "utf8");
}

export function readCollectionMode(stateDir) {
  const { config } = pathsFor(stateDir);
  if (!fs.existsSync(config)) return "undecided";
  assertNotSymlink(config);
  try {
    const value = JSON.parse(fs.readFileSync(config, "utf8"));
    return value?.schema === 1 && COLLECTION_MODES.has(value.mode) ? value.mode : "undecided";
  } catch {
    return "undecided";
  }
}

export async function setCollectionMode({ stateDir, mode, signal }) {
  if (!COLLECTION_MODES.has(mode)) throw new Error("Collection mode must be on or off");
  return withStateLock(stateDir, signal, async () => {
    atomicWrite(pathsFor(stateDir).config, `${JSON.stringify({ schema: 1, mode })}\n`, 0o600);
    return { mode };
  });
}

export async function recordCapabilityGap(options) {
  const { stateDir, sessionId, runId, cwd, gap, signal, now = new Date().toISOString(), maxEventFileBytes = MAX_EVENT_FILE_BYTES } = options;
  return withStateLock(stateDir, signal, async () => {
    if (readCollectionMode(stateDir) !== "on") {
      throw new Error("Local wishlist collection must be explicitly on before recording observations");
    }
    if (!Number.isFinite(timestampMs(now))) throw new Error("Observation timestamp is invalid");
    const files = pathsFor(stateDir);
    const parsed = readEventsFile(files.events);
    const decisionData = readDecisionsFile(files.decisions);
    const salt = getSalt(files.salt);
    const sessionHash = privateHash(salt, sessionId || "ephemeral-session");
    const runHash = privateHash(salt, `${sessionId || "ephemeral-session"}\0${runId || "unknown-run"}`);
    const projectHash = privateHash(salt, path.resolve(cwd || process.cwd()));
    const sanitized = sanitizeGap(gap);
    const aliases = buildAliasMap(decisionData.decisions);
    const observedKey = normalizeCapability(sanitized.capability);
    const canonicalKey = resolveAlias(observedKey, aliases);
    const states = lifecycleStates(decisionData.decisions);
    const priorState = states.get(canonicalKey) ?? (registryCapability(canonicalKey) ? "retired" : "open");
    const regression = priorState === "retired";
    const duplicate = parsed.events.some((event) => resolveAlias(event.observedKey ?? event.canonicalKey, aliases) === canonicalKey && event.runHash === runHash);
    if (!duplicate) {
      const event = {
        schema: 1, timestamp: now, observedKey, canonicalKey: observedKey, sessionHash, runHash, projectHash,
        ...sanitized, ...(regression ? { regression: true } : {}),
      };
      parsed.bytes = appendBounded(files.events, event, parsed.bytes ?? 0, maxEventFileBytes, "Tool wishlist event log");
      parsed.events.push(event);
    }
    writeReport(files.report, parsed.events, decisionData.decisions, parsed.invalidLines, decisionData.invalidLines, now);
    const groups = groupsWithState(parsed.events, decisionData.decisions);
    const queued = groups.filter((item) => ["open", "selected"].includes(item.state));
    const group = groups.find((item) => item.canonicalKey === canonicalKey);
    return {
      duplicate, regression, resolved: priorState === "retired", canonicalKey, reportPath: files.report,
      occurrences: group?.occurrences ?? 0, sessions: group?.sessions ?? 0,
      priority: group?.priority ?? 0, reviewNeeded: group?.reviewNeeded ?? false, uniqueGaps: queued.length,
      invalidLines: parsed.invalidLines + decisionData.invalidLines,
    };
  });
}

function currentStateFor(key, decisions) {
  return lifecycleStates(decisions).get(key) ?? (registryCapability(key) ? "retired" : "open");
}

function validateStateTransition(action, current) {
  if (action === "select" && !["open", "declined"].includes(current)) return false;
  if (action === "decline" && !["open", "selected"].includes(current)) return false;
  if (action === "retire" && current !== "selected") return false;
  if (action === "reopen" && !["retired", "declined"].includes(current)) return false;
  return true;
}

export async function appendWishlistDecision(options) {
  const { stateDir, action, canonicalKey, targetKey = "", note = "", signal, now = new Date().toISOString(), maxDecisionFileBytes = MAX_DECISION_FILE_BYTES } = options;
  if (!DECISION_ACTIONS.has(action)) throw new Error(`Unknown wishlist action: ${action}`);
  return withStateLock(stateDir, signal, async () => {
    if (!Number.isFinite(timestampMs(now))) throw new Error("Decision timestamp is invalid");
    const files = pathsFor(stateDir);
    const parsed = readEventsFile(files.events);
    const decisionData = readDecisionsFile(files.decisions);
    const aliases = buildAliasMap(decisionData.decisions);
    const key = resolveAlias(normalizeCapability(canonicalKey), aliases);
    let target = targetKey ? resolveAlias(normalizeCapability(targetKey), aliases) : "";
    const known = new Set([
      ...canonicalizeEvents(parsed.events, decisionData.decisions).map((event) => event.canonicalKey),
      ...CAPABILITY_REGISTRY.capabilities.map((item) => item.id),
    ]);
    if (!known.has(key) && action !== "unmerge") throw new Error(`Unknown wishlist gap: ${key}`);
    if (STATE_ACTIONS.has(action)) {
      const current = currentStateFor(key, decisionData.decisions);
      if (!validateStateTransition(action, current)) throw new Error(`Cannot ${action} ${key} while its state is ${current}`);
      if (action === "retire" && sanitizeReportText(note, 240).length < 5) {
        throw new Error("Retirement requires a short sanitized validation note");
      }
    } else if (action === "merge") {
      if (!known.has(target)) throw new Error(`Unknown merge target: ${target}`);
      if (registryCapability(key)) throw new Error("Reviewed registry capabilities cannot be merged into another ID");
      if (key === target) throw new Error("Cannot merge a gap into itself");
      const prospective = new Map(aliases).set(key, target);
      if (resolveAlias(target, prospective) === key) throw new Error("Capability aliases must not form a cycle");
    } else if (action === "unmerge") {
      const reversed = new Set(decisionData.decisions.filter((item) => item.action === "unmerge").map((item) => item.reverses));
      const merge = decisionData.decisions.find((item) => item.id === canonicalKey && item.action === "merge" && !reversed.has(item.id));
      if (!merge) throw new Error(`No active merge decision exists with ID ${canonicalKey}`);
      target = merge.targetKey;
    }
    const reversedMerge = action === "unmerge"
      ? decisionData.decisions.find((item) => item.id === canonicalKey && item.action === "merge")
      : undefined;
    const decision = {
      schema: 1,
      id: randomUUID(),
      timestamp: now,
      action,
      canonicalKey: reversedMerge?.canonicalKey ?? key,
      targetKey: target,
      reverses: reversedMerge?.id ?? "",
      note: sanitizeReportText(note, 240),
    };
    appendBounded(files.decisions, decision, decisionData.bytes ?? 0, maxDecisionFileBytes, "Tool wishlist decision log");
    decisionData.decisions.push(decision);
    const report = writeReport(files.report, parsed.events, decisionData.decisions, parsed.invalidLines, decisionData.invalidLines, now);
    return { action, decisionId: decision.id, canonicalKey: decision.canonicalKey, targetKey: decision.targetKey, reportPath: files.report, report };
  });
}

export async function refreshWishlist(options) {
  const { stateDir, signal, now = new Date().toISOString() } = options;
  return withStateLock(stateDir, signal, async () => {
    const files = pathsFor(stateDir);
    const parsed = readEventsFile(files.events);
    const decisionData = readDecisionsFile(files.decisions);
    const report = writeReport(files.report, parsed.events, decisionData.decisions, parsed.invalidLines, decisionData.invalidLines, now);
    const groups = queueGroups(parsed.events, decisionData.decisions);
    return {
      reportPath: files.report, report,
      next: renderNextWishlist(parsed.events, decisionData.decisions),
      uniqueGaps: groups.length,
      occurrences: groups.reduce((total, group) => total + group.occurrences, 0),
      invalidLines: parsed.invalidLines + decisionData.invalidLines,
      events: parsed.events,
      decisions: decisionData.decisions,
    };
  });
}

export async function createIssueDraft({ stateDir, canonicalKey, signal }) {
  return withStateLock(stateDir, signal, async () => {
    const files = pathsFor(stateDir);
    const parsed = readEventsFile(files.events);
    const decisionData = readDecisionsFile(files.decisions);
    return { canonicalKey: normalizeCapability(canonicalKey), markdown: renderIssueDraft(parsed.events, decisionData.decisions, canonicalKey) };
  });
}

function archiveStamp(value) {
  return String(value).replace(/[:.]/g, "-");
}

export async function archiveWishlist({ stateDir, signal, now = new Date().toISOString(), reason = "archive", failAfterPrepared = false }) {
  return withStateLock(stateDir, signal, async () => {
    const files = pathsFor(stateDir);
    assertNotSymlink(files.archives);
    fs.mkdirSync(files.archives, { recursive: true, mode: 0o700 });
    const archiveDir = path.join(files.archives, `${archiveStamp(now)}-${reason}`);
    fs.mkdirSync(archiveDir, { recursive: false, mode: 0o700 });
    const prepared = [];
    for (const key of ["events", "decisions", "report"]) {
      const source = files[key];
      if (!fs.existsSync(source)) continue;
      assertNotSymlink(source);
      const name = path.basename(source);
      const target = path.join(archiveDir, name);
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(target, 0o600);
      prepared.push({ name, sha256: fileHash(target) });
    }
    const manifest = { schema: 1, timestamp: now, reason, files: prepared };
    atomicWrite(path.join(archiveDir, "archive.json"), `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
    atomicWrite(files.archiveTransaction, `${JSON.stringify({ ...manifest, archiveDir })}\n`, 0o600);
    if (failAfterPrepared) throw new Error("Injected failure after archive preparation");
    recoverArchiveTransaction(stateDir);
    return { archiveDir, moved: prepared.map((item) => item.name), reportPath: files.report, report: fs.readFileSync(files.report, "utf8") };
  });
}
