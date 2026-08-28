import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const MAX_EVENT_FILE_BYTES = 5 * 1024 * 1024;
const IMPACT_WEIGHT = { minor: 1, degraded: 2, blocked: 4 };
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "capability",
  "for",
  "missing",
  "need",
  "needed",
  "of",
  "support",
  "the",
  "to",
  "tool",
  "tools",
]);

export const WISHLIST_FILENAMES = {
  events: "tool-wishlist-events.jsonl",
  report: "TOOL_WISHLIST.md",
  salt: ".tool-wishlist-salt",
  lock: ".tool-wishlist.lock",
};

function compactText(value, maxLength) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeToken(token) {
  if (token.length > 4 && token.endsWith("s") && !token.endsWith("ss")) {
    return token.slice(0, -1);
  }
  return token;
}

export function normalizeCapability(value) {
  const tokens = compactText(value, 120)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map(normalizeToken)
    .filter((token) => !STOP_WORDS.has(token));
  return [...new Set(tokens)].slice(0, 10).join("-") || "uncategorized-gap";
}

function keyTokens(key) {
  return new Set(key.split("-").filter(Boolean));
}

function similarity(left, right) {
  const a = keyTokens(left);
  const b = keyTokens(right);
  if (a.size < 2 || b.size < 2) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

export function chooseCanonicalKey(proposed, events) {
  const normalized = normalizeCapability(proposed);
  const existing = [...new Set(events.map((event) => event.canonicalKey).filter(Boolean))];
  if (existing.includes(normalized)) return normalized;

  const close = existing
    .map((key) => ({ key, score: similarity(normalized, key) }))
    .filter(({ score }) => score >= 0.8)
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  return close[0]?.key ?? normalized;
}

function pathsFor(stateDir) {
  return {
    events: path.join(stateDir, WISHLIST_FILENAMES.events),
    report: path.join(stateDir, WISHLIST_FILENAMES.report),
    salt: path.join(stateDir, WISHLIST_FILENAMES.salt),
    lock: path.join(stateDir, WISHLIST_FILENAMES.lock),
  };
}

function assertNotSymlink(file) {
  try {
    if (fs.lstatSync(file).isSymbolicLink()) {
      throw new Error(`Refusing to use symlinked wishlist state: ${file}`);
    }
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
    if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error;
  }
}

function releaseOwnedLock(lock, marker) {
  try {
    fs.unlinkSync(marker);
  } catch (error) {
    // A missing owner-specific marker means the lock path was replaced. Never
    // remove that replacement on behalf of the former owner.
    if (error.code === "ENOENT") return;
    throw error;
  }
  // Non-recursive removal cannot delete a replacement containing another
  // owner's marker.
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
      return await operation();
    } finally {
      if (markerWritten) releaseOwnedLock(lock, marker);
      else removeEmptyLockDirectory(lock);
    }
  }
  throw new Error(
    `Timed out waiting for ${lock}. Remove it only after confirming no Pi session is updating the wishlist.`,
  );
}

function isStoredEvent(event) {
  return (
    event?.schema === 1 &&
    typeof event.timestamp === "string" &&
    typeof event.canonicalKey === "string" &&
    typeof event.sessionHash === "string" &&
    typeof event.runHash === "string" &&
    typeof event.projectHash === "string" &&
    typeof event.capability === "string" &&
    typeof event.scenario === "string" &&
    typeof event.limitation === "string" &&
    Object.hasOwn(IMPACT_WEIGHT, event.impact) &&
    typeof event.workaround === "string" &&
    ["tool", "skill", "prompt", "config", "bug", "unknown"].includes(event.suggestedFix)
  );
}

export function readEventsFile(file) {
  if (!fs.existsSync(file)) return { events: [], invalidLines: 0 };
  assertNotSymlink(file);
  const stat = fs.statSync(file);
  const events = [];
  let invalidLines = 0;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (isStoredEvent(event)) events.push(event);
      else invalidLines += 1;
    } catch {
      invalidLines += 1;
    }
  }
  return { events, invalidLines, bytes: stat.size };
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

function uniqueByRun(events) {
  const seen = new Set();
  const result = [];
  for (const event of events) {
    const identity = `${event.canonicalKey}\0${event.runHash}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push(event);
  }
  return result;
}

function mostCommon(values) {
  const counts = new Map();
  for (const value of values.filter(Boolean)) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
}

export function aggregateEvents(events) {
  const groups = new Map();
  for (const event of uniqueByRun(events)) {
    const group = groups.get(event.canonicalKey) ?? [];
    group.push(event);
    groups.set(event.canonicalKey, group);
  }

  return [...groups.entries()]
    .map(([canonicalKey, items]) => {
      const ordered = [...items].sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
      const impacts = ordered.map((event) => event.impact);
      const highestImpact = impacts.sort((a, b) => IMPACT_WEIGHT[b] - IMPACT_WEIGHT[a])[0] ?? "minor";
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
      return {
        canonicalKey,
        title: ordered.at(-1)?.capability ?? canonicalKey,
        occurrences: ordered.length,
        sessions: distinct("sessionHash"),
        projects: distinct("projectHash"),
        firstSeen: ordered[0]?.timestamp,
        lastSeen: ordered.at(-1)?.timestamp,
        impact: highestImpact,
        suggestedFix: mostCommon(ordered.map((event) => event.suggestedFix)) ?? "unknown",
        priority: ordered.reduce((total, event) => total + (IMPACT_WEIGHT[event.impact] ?? 1), 0),
        scenarios: recentUnique("scenario"),
        limitations: recentUnique("limitation"),
        workarounds: recentUnique("workaround"),
      };
    })
    .sort((a, b) => b.priority - a.priority || b.sessions - a.sessions || a.canonicalKey.localeCompare(b.canonicalKey));
}

function markdownText(value) {
  return compactText(value, 500).replace(/([\\`*_[\]<>#])/g, "\\$1");
}

function day(value) {
  return String(value ?? "").slice(0, 10) || "unknown";
}

export function renderWishlist(events, options = {}) {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const invalidLines = options.invalidLines ?? 0;
  const groups = aggregateEvents(events);
  const totalOccurrences = groups.reduce((total, group) => total + group.occurrences, 0);
  const lines = [
    "# Tool Wishlist",
    "",
    "> Generated by ZenPi from privacy-minimized capability-gap reports. Do not edit this file directly.",
    "> Raw events contain only sanitized summaries and salted hashes for session/project counting.",
    "",
    `Generated: ${generatedAt}`,
    `Unique gaps: ${groups.length} | Recorded occurrences: ${totalOccurrences}`,
    "",
    "Priority is the sum of impact weights across unique user tasks (`minor=1`, `degraded=2`, `blocked=4`).",
  ];
  if (invalidLines > 0) lines.push(`Warning: ${invalidLines} malformed event line(s) were ignored.`);

  if (groups.length === 0) {
    lines.push("", "No capability gaps have been recorded yet.", "");
    return lines.join("\n");
  }

  for (const group of groups) {
    lines.push(
      "",
      `## ${markdownText(group.title)}`,
      "",
      `- ID: \`${group.canonicalKey}\``,
      `- Priority: **${group.priority}**`,
      `- Occurrences: ${group.occurrences}`,
      `- Distinct sessions: ${group.sessions}`,
      `- Distinct projects: ${group.projects}`,
      `- Impact: ${group.impact}`,
      `- Suggested fix: ${group.suggestedFix}`,
      `- First seen: ${day(group.firstSeen)}`,
      `- Last seen: ${day(group.lastSeen)}`,
    );
    if (group.scenarios.length) {
      lines.push("", "**Observed needs**", ...group.scenarios.map((value) => `- ${markdownText(value)}`));
    }
    if (group.limitations.length) {
      lines.push("", "**Why current capabilities fell short**", ...group.limitations.map((value) => `- ${markdownText(value)}`));
    }
    if (group.workarounds.length) {
      lines.push("", "**Workarounds used**", ...group.workarounds.map((value) => `- ${markdownText(value)}`));
    }
  }
  lines.push("");
  return lines.join("\n");
}

function writeReport(reportPath, events, invalidLines, generatedAt) {
  const report = renderWishlist(events, { invalidLines, generatedAt });
  atomicWrite(reportPath, report, 0o600);
  return report;
}

export async function recordCapabilityGap(options) {
  const {
    stateDir,
    sessionId,
    runId,
    cwd,
    gap,
    signal,
    now = new Date().toISOString(),
    maxEventFileBytes = MAX_EVENT_FILE_BYTES,
  } = options;

  return withStateLock(stateDir, signal, async () => {
    const files = pathsFor(stateDir);
    const parsed = readEventsFile(files.events);
    const salt = getSalt(files.salt);
    const sessionHash = privateHash(salt, sessionId || "ephemeral-session");
    const runHash = privateHash(salt, `${sessionId || "ephemeral-session"}\0${runId || "unknown-run"}`);
    const projectHash = privateHash(salt, path.resolve(cwd || process.cwd()));
    const sanitized = sanitizeGap(gap);
    const canonicalKey = chooseCanonicalKey(sanitized.capability, parsed.events);

    const duplicate = parsed.events.some(
      (event) => event.canonicalKey === canonicalKey && event.runHash === runHash,
    );
    if (!duplicate) {
      assertNotSymlink(files.events);
      const event = {
        schema: 1,
        timestamp: now,
        canonicalKey,
        sessionHash,
        runHash,
        projectHash,
        ...sanitized,
      };
      const encoded = `${JSON.stringify(event)}\n`;
      const currentBytes = parsed.bytes ?? 0;
      if (currentBytes + Buffer.byteLength(encoded, "utf8") > maxEventFileBytes) {
        throw new Error(
          `Tool wishlist event log reached its ${maxEventFileBytes}-byte limit. Archive ${files.events} before recording more gaps; /wishlist can still refresh the existing report.`,
        );
      }
      fs.appendFileSync(files.events, encoded, { encoding: "utf8", mode: 0o600 });
      parsed.events.push(event);
      parsed.bytes = currentBytes + Buffer.byteLength(encoded, "utf8");
    }

    writeReport(files.report, parsed.events, parsed.invalidLines, now);
    const groups = aggregateEvents(parsed.events);
    const group = groups.find((item) => item.canonicalKey === canonicalKey);
    return {
      duplicate,
      canonicalKey,
      reportPath: files.report,
      occurrences: group?.occurrences ?? 0,
      sessions: group?.sessions ?? 0,
      priority: group?.priority ?? 0,
      uniqueGaps: groups.length,
      invalidLines: parsed.invalidLines,
    };
  });
}

export async function refreshWishlist(options) {
  const { stateDir, signal, now = new Date().toISOString() } = options;
  return withStateLock(stateDir, signal, async () => {
    const files = pathsFor(stateDir);
    const parsed = readEventsFile(files.events);
    const report = writeReport(files.report, parsed.events, parsed.invalidLines, now);
    const groups = aggregateEvents(parsed.events);
    return {
      reportPath: files.report,
      report,
      uniqueGaps: groups.length,
      occurrences: groups.reduce((total, group) => total + group.occurrences, 0),
      invalidLines: parsed.invalidLines,
    };
  });
}
