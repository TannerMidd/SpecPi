// Generates t4-research-dossier: a thousand-document knowledge base and a bank of
// 45 questions whose answers are only reachable by joining documents.
//
// The corpus is built so the three cheap strategies all fail:
//
//  1. No reading it all. Roughly 2.5 MB of markdown is far past any context
//     window, and the question bank is sized past the time budget as well, so
//     the score is yield rather than completion.
//  2. No single grep. Policy documents name services only by codename, and
//     the codename lives in the registry. Every question is at least two
//     hops, and the incident questions are three.
//  3. No first hit. Superseded policies stay in the corpus and are repeated
//     in archived drafts, so the value a search ranks first is usually the
//     one that is no longer in force. The document that supersedes it says
//     so in its own header; nothing else marks the older one as stale.
//
// The key is derived from the same data the documents are rendered from, so
// a question's answer cannot drift from what the corpus says.
//
// Regenerate with:
//
//     node evals/tasks/t4-research-dossier/generate.mjs \
//         evals/tasks/t4-research-dossier/workspace

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";

const root = path.resolve(process.argv[2]);
const taskDir = path.dirname(root);
const corpus = path.join(root, "corpus");

let seed = 20260918;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed / 0x7fffffff);
const pick = (list) => list[Math.floor(rnd() * list.length)];
const between = (low, high) => low + Math.floor(rnd() * (high - low + 1));

const TEAM_WORDS = [
    "amber",
    "basalt",
    "cedar",
    "damask",
    "ember",
    "flax",
    "garnet",
    "hazel",
    "indigo",
    "jasper",
    "kelp",
    "larch",
];

const ADJECTIVES = [
    "northern",
    "coastal",
    "inland",
    "upper",
    "lower",
    "eastern",
    "western",
    "central",
    "outer",
    "inner",
    "quiet",
    "rapid",
];

const NOUNS = [
    "ingest",
    "relay",
    "ledger",
    "digest",
    "fanout",
    "shard",
    "gateway",
    "reaper",
    "sweeper",
    "courier",
    "beacon",
    "warden",
];

const QUARTERS = ["2025-Q3", "2025-Q4", "2026-Q1", "2026-Q2"];
const POLICIES = [
    { id: "retry-budget", label: "retry budget", unit: "attempts", low: 2, high: 19 },
    { id: "fanout-limit", label: "fan-out limit", unit: "peers", low: 3, high: 31 },
    { id: "batch-ceiling", label: "batch ceiling", unit: "records", low: 50, high: 900 },
];

const CONFIG_KEYS = [
    "ingest.spool.mode",
    "relay.compat.v1",
    "ledger.replay.window",
    "digest.partial.flush",
    "fanout.peer.pinning",
    "shard.rebalance.eager",
    "gateway.legacy.headers",
    "reaper.grace.seconds",
];

/* ------------------------------------------------------------- entities */

const teams = TEAM_WORDS.map((word) => ({
    id: `team-${word}`,
    word,
    channel: `#ops-${word}`,
    rota: `${word}-primary`,
}));

const usedCodenames = new Set();
const services = [];
while (services.length < 60) {
    const codename = `${pick(ADJECTIVES)} ${pick(NOUNS)}`;
    if (usedCodenames.has(codename)) {
        continue;
    }

    usedCodenames.add(codename);
    const index = services.length;
    services.push({
        id: `svc-${String(index + 1).padStart(3, "0")}`,
        codename,
        team: teams[index % teams.length],
        metric: `${codename.split(" ").join("_")}_lag_seconds`,
        tier: between(1, 3),
    });
}

const incidents = [];
for (let index = 0; index < 160; index++) {
    incidents.push({
        id: `INC-${String(index + 1).padStart(3, "0")}`,
        service: services[Math.floor(rnd() * services.length)],
        quarter: QUARTERS[index % QUARTERS.length],
        minutes: between(7, 240),
    });
}

/* ------------------------------------------------------------- questions */

let rfcCounter = 0;
const nextRfc = () => `RFC-${String(++rfcCounter).padStart(3, "0")}`;
const rfcs = new Map();
const waivers = [];
const notes = [];
const questions = [];

function addRfc(id, title, body, header = {}) {
    rfcs.set(id, { id, title, body, header });
}

// Archetype A: a policy set once and changed later. The question names only
// the service, so both documents have to be found and ordered; an archived
// draft repeats the superseded value and usually ranks above the RFC that
// replaced it.
for (let index = 0; index < 8; index++) {
    const service = services[index * 7 + 1];
    const policy = POLICIES[index % POLICIES.length];
    const original = between(policy.low, policy.high);
    let replacement = between(policy.low, policy.high);
    while (replacement === original) {
        replacement = between(policy.low, policy.high);
    }

    const first = nextRfc();
    const second = nextRfc();
    addRfc(
        first,
        `${policy.label} for ${service.codename}`,
        `The ${service.codename} path has operated without a documented ${policy.label} since migration.
This RFC fixes it at **${original} ${policy.unit}** and asks the owning team to alert on breaches.

Operators should note that the ${policy.label} is a per-path figure, not a per-host one.`,
        { Status: "superseded", "Superseded-by": second },
    );
    addRfc(
        second,
        `Revised ${policy.label} for ${service.codename}`,
        `Load testing after the ${pick(QUARTERS)} capacity review shows the ${policy.label} agreed in ${first}
is too conservative for the ${service.codename} path. It is raised to **${replacement} ${policy.unit}**,
effective immediately.

This is the figure in force. ${first} is superseded in full.`,
        { Status: "active", Supersedes: first },
    );
    notes.push({
        id: null,
        kind: "notes",
        title: `Draft: ${policy.label} for ${service.codename}`,
        status: "archived",
        body: `Archived working draft. Kept for the record only; see the RFC index for what is in force.

The proposal is to hold the ${policy.label} at ${original} ${policy.unit} for the ${service.codename}
path, matching the other tier-${service.tier} paths. Discussion continued in review and the
figure moved; this draft was not updated.`,
    });
    questions.push({
        id: `Q${String(questions.length + 1).padStart(2, "0")}`,
        archetype: "current-policy",
        prompt: `What ${policy.label} is in force for the ${service.codename} path today? Answer with the number only.`,
        answer: String(replacement),
        answerKind: "number",
        sources: [first, second],
    });
}

// Archetype B: a metric named in a telemetry note, an owner named in the
// registry. The metric never appears in the registry and the owner never
// appears in the note.
for (let index = 0; index < 8; index++) {
    const service = services[index * 5 + 2];
    const noteTitle = `Telemetry: ${service.codename}`;
    notes.push({
        id: null,
        kind: "notes",
        title: noteTitle,
        status: "active",
        body: `The ${service.codename} path emits \`${service.metric}\` once per flush cycle.
Alerting fires when the series is stale for more than two cycles.

The series is tagged by region and by rota, but not by owner: use the service registry
to resolve the owning team before paging anyone.`,
        anchor: `metric:${service.metric}`,
    });
    questions.push({
        id: `Q${String(questions.length + 1).padStart(2, "0")}`,
        archetype: "metric-owner",
        prompt: `Which team owns the service that emits the metric \`${service.metric}\`? Answer with the team id only.`,
        answer: service.team.id,
        answerKind: "token",
        sources: [`metric:${service.metric}`, service.id],
    });
}

// Archetype C: three hops. The incident names a codename, the registry maps
// it to a team, the team page carries the channel.
for (let index = 0; index < 8; index++) {
    const incident = incidents[index * 4 + 1];
    questions.push({
        id: `Q${String(questions.length + 1).padStart(2, "0")}`,
        archetype: "incident-escalation",
        prompt: `Which escalation channel covers the team responsible for ${incident.id}? Answer with the channel only.`,
        answer: incident.service.team.channel,
        answerKind: "token",
        sources: [incident.id, incident.service.id, incident.service.team.id],
    });
}

// Archetype D: a count that needs the registry to resolve ownership before
// the incidents can be filtered.
// A (team, quarter) cell with nothing in it makes an unciteable question, so
// the cells are chosen from the data rather than assumed: the seven with the
// most incidents, which are also the seven with the most to miscount.
const cells = [];
for (const team of teams) {
    for (const quarter of QUARTERS) {
        const matching = incidents.filter(
            (incident) => incident.service.team.id === team.id && incident.quarter === quarter,
        );
        if (matching.length >= 2) {
            cells.push({ team, quarter, matching });
        }
    }
}

cells.sort((a, b) => b.matching.length - a.matching.length || (a.team.id < b.team.id ? -1 : 1));
for (const { team, quarter, matching } of cells.slice(0, 7)) {
    questions.push({
        id: `Q${String(questions.length + 1).padStart(2, "0")}`,
        archetype: "incident-count",
        prompt: `How many incidents in ${quarter} were caused by services owned by ${team.id}? Answer with the number only.`,
        answer: String(matching.length),
        answerKind: "number",
        sources: matching.map((incident) => incident.id),
        extraAllowance: 6,
    });
}

// Archetype E: a global default that a waiver overrides for one service. The
// default is repeated across the corpus; the waiver appears once.
const timeoutRfc = nextRfc();
const defaultTimeout = 2500;
addRfc(
    timeoutRfc,
    "Default request timeout and waivers",
    `Every request-serving path uses a default request timeout of **${defaultTimeout} ms** unless an
approved waiver says otherwise. Waivers are recorded under \`corpus/waivers/\` and name the
path they cover by codename.

A path without a waiver uses the default. A path with one uses the waiver, and the waiver
does not expire unless it says so.`,
    { Status: "active" },
);
for (let index = 0; index < 7; index++) {
    const service = services[index * 8 + 3];
    const granted = between(300, 9000);
    const waiver = { id: `WAIVER-${String(index + 1).padStart(3, "0")}`, service, granted };
    waivers.push(waiver);
    questions.push({
        id: `Q${String(questions.length + 1).padStart(2, "0")}`,
        archetype: "waiver-timeout",
        prompt: `What request timeout, in milliseconds, applies to the ${service.codename} path? Answer with the number only.`,
        answer: String(granted),
        answerKind: "number",
        sources: [timeoutRfc, waiver.id],
    });
}

// Archetype F: a key deprecated and then reinstated, so the document that
// says "deprecated" is real, correct for its date, and no longer governing.
for (let index = 0; index < 7; index++) {
    const key = CONFIG_KEYS[index % CONFIG_KEYS.length];
    const deprecating = nextRfc();
    const reinstating = nextRfc();
    addRfc(
        deprecating,
        `Deprecate ${key}`,
        `\`${key}\` is deprecated. It was introduced for a migration that finished two releases ago
and no supported deployment sets it.

Configuration that still sets \`${key}\` will warn at start-up and the key will be ignored.`,
        { Status: "superseded", "Superseded-by": reinstating },
    );
    addRfc(
        reinstating,
        `Reinstate ${key}`,
        `Deprecating \`${key}\` in ${deprecating} was premature: three deployments depend on it and
no replacement exists. The key is reinstated and supported.

${deprecating} is superseded. \`${key}\` is governed by this RFC.`,
        { Status: "active", Supersedes: deprecating },
    );
    questions.push({
        id: `Q${String(questions.length + 1).padStart(2, "0")}`,
        archetype: "reinstated-key",
        prompt: `Which RFC governs the configuration key \`${key}\` today? Answer with the RFC id only.`,
        answer: reinstating,
        answerKind: "token",
        sources: [deprecating, reinstating],
    });
}

/* ------------------------------------------------------------ filler docs */

// Filler is not padding: it is what makes retrieval a choice. Every note here
// uses the same vocabulary as the documents that carry answers, repeats the
// global default, and mentions codenames in passing.
const TOPICS = [
    "capacity review",
    "rota handover",
    "deploy retrospective",
    "dependency audit",
    "latency triage",
    "schema migration",
    "runbook revision",
    "cost review",
    "backfill plan",
    "load shedding",
];

while (rfcCounter < 120) {
    const id = nextRfc();
    const service = pick(services);
    const policy = pick(POLICIES);
    const topic = pick(TOPICS);
    addRfc(
        id,
        `${topic} for ${service.codename}`,
        `A ${topic} for the ${service.codename} path, filed by ${service.team.id}.

The ${policy.label} was reviewed and left at its documented value. The default request timeout
of ${defaultTimeout} ms applies to this path; no waiver was requested. Escalation continues to
route through the owning team's channel.

No change is proposed. This RFC is recorded so the review is traceable.`,
        { Status: "active" },
    );
}

const ATTENDEE_ROLES = [
    "the on-call primary",
    "the secondary",
    "a platform reviewer",
    "the release manager",
    "a capacity planner",
    "the incident commander from the previous rotation",
];

for (let index = 0; index < 1300; index++) {
    const service = pick(services);
    const other = pick(services);
    const topic = pick(TOPICS);
    const incident = pick(incidents);
    const policy = pick(POLICIES);
    const sections = [];
    // Filler is what makes retrieval a choice rather than a formality, and a
    // note that is three lines long does not make anyone choose. These are as
    // long as the real thing, use the same vocabulary as the documents that
    // carry answers, and quote the global default the waivers override.
    sections.push(`Notes from the ${topic} covering the ${service.codename} path, recorded by
${pick(ATTENDEE_ROLES)}. Attendance was quorate and the agenda was taken in order.`);
    sections.push(`## Dependencies

Attendees walked the dependency list and confirmed the ${service.codename} path still reports
through its usual rota. Its nearest neighbour on the call graph is the ${other.codename} path,
which was reviewed separately and is not covered here. Neither path changed ownership this
period; the registry is the authority on that and was not amended.`);
    sections.push(`## Timeouts and budgets

The default request timeout of ${defaultTimeout} ms was quoted during the session and nobody
proposed departing from it. Waivers were discussed in the abstract: a path with an approved
waiver uses the waiver, a path without one uses the default, and this note grants nothing.

The ${policy.label} was mentioned in passing. It is documented in the RFC series and this note
does not restate the figure, because notes that restate figures go stale and this one would.`);
    sections.push(`## Prior art

${incident.id} came up as prior art. Nobody present owned it, and the report itself names only
the impacted path, so the owning team was not identified during the session. ${pick(incidents).id}
was raised as a possible duplicate and left open.`);
    sections.push(`## Follow-ups

Follow-ups were recorded against the owning team and will be picked up in the next ${topic}.
Nothing in this note changes a policy: policy lives in the RFC series and is superseded there,
not here. Where this note and an RFC disagree, the RFC is right.`);
    notes.push({
        id: null,
        kind: "notes",
        title: `${topic}: ${service.codename}`,
        status: rnd() < 0.15 ? "archived" : "active",
        body: sections.join("\n\n"),
    });
}

/* ------------------------------------------------------------- rendering */

fs.rmSync(corpus, { recursive: true, force: true });
for (const kind of ["rfcs", "registry", "teams", "incidents", "waivers", "notes"]) {
    fs.mkdirSync(path.join(corpus, kind), { recursive: true });
}

function header(fields) {
    return Object.entries(fields)
        .map(([name, value]) => `${name}: ${value}`)
        .join("\n");
}

function write(kind, id, title, fields, body) {
    fs.writeFileSync(
        path.join(corpus, kind, `${id}.md`),
        `# ${id} — ${title}\n\n${header({ Id: id, ...fields })}\n\n${body.trim()}\n`,
    );
}

for (const rfc of rfcs.values()) {
    write("rfcs", rfc.id, rfc.title, rfc.header, rfc.body);
}

for (const service of services) {
    write(
        "registry",
        service.id,
        service.codename,
        { Codename: service.codename, Owner: service.team.id, Tier: String(service.tier) },
        `The ${service.codename} path is registered as ${service.id} and owned by ${service.team.id}.

Policy documents refer to this path by its codename rather than its id, so resolve the
codename here before reading the RFC series. Paging goes through the owning team, whose
page records the channel and rota.`,
    );
}

for (const team of teams) {
    write(
        "teams",
        team.id,
        `Team ${team.word}`,
        { Channel: team.channel, Rota: team.rota },
        `${team.id} escalates through ${team.channel} and pages the ${team.rota} rota.

The team owns several registered paths. The registry is the authority on which ones; this
page does not list them, because the list changes more often than this page does.`,
    );
}

for (const incident of incidents) {
    write(
        "incidents",
        incident.id,
        `${incident.minutes}-minute degradation`,
        { Quarter: incident.quarter, "Impacted-path": incident.service.codename },
        `The ${incident.service.codename} path degraded for ${incident.minutes} minutes.

The impacted path is named above by codename. This report does not name an owning team:
ownership is resolved through the service registry at the time of the page, because it
changes and this report does not.`,
    );
}

for (const waiver of waivers) {
    write(
        "waivers",
        waiver.id,
        `Request timeout waiver for ${waiver.service.codename}`,
        { Status: "approved", Path: waiver.service.codename },
        `The ${waiver.service.codename} path is granted a request timeout of **${waiver.granted} ms**,
replacing the global default for this path only.

The waiver does not expire. It covers the codename above and no other path.`,
    );
}

let noteCounter = 0;
for (const note of notes) {
    note.id = `note-${String(++noteCounter).padStart(3, "0")}`;
    write("notes", note.id, note.title, { Status: note.status }, note.body);
}

// Anchored sources are written as codenames in the question key, then
// resolved to the note that actually carries them, so the key cites the
// document a reader would cite.
const anchors = new Map(notes.filter((note) => note.anchor).map((note) => [note.anchor, note.id]));
for (const question of questions) {
    question.sources = question.sources.map((source) => anchors.get(source) ?? source);
}

/* ----------------------------------------------------------- key writing */

fs.writeFileSync(path.join(taskDir, "KEY.json"), `${JSON.stringify(questions, null, 2)}\n`);

fs.writeFileSync(
    path.join(root, "QUESTIONS.md"),
    `# Question bank

${questions.length} questions. Each is answerable from the corpus; none is answerable from
one document. Answer with the bare value and nothing else — a number with no units, an
id with no prose.

${questions.map((question) => `## ${question.id}\n\n${question.prompt}\n`).join("\n")}`,
);

const fixtures = {};
const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walk(full);
        } else if (entry.isFile()) {
            const relative = path.relative(root, full).split(path.sep).join("/");
            const text = fs.readFileSync(full, "utf8").split("\r\n").join("\n");
            fixtures[relative] = createHash("sha256").update(text).digest("hex");
        }
    }
};

walk(corpus);
for (const name of ["QUESTIONS.md", ".kb-impl.mjs"]) {
    const text = fs.readFileSync(path.join(root, name), "utf8").split("\r\n").join("\n");
    fixtures[name] = createHash("sha256").update(text).digest("hex");
}

fs.writeFileSync(path.join(taskDir, "FIXTURES.json"), `${JSON.stringify(fixtures, null, 2)}\n`);

const bytes = Object.keys(fixtures)
    .filter((relative) => relative.startsWith("corpus/"))
    .reduce((total, relative) => total + fs.statSync(path.join(root, relative)).size, 0);
console.log(`documents: ${Object.keys(fixtures).length - 2}, ${(bytes / 1024 / 1024).toFixed(2)} MB`);
console.log(`questions: ${questions.length}, services: ${services.length}, teams: ${teams.length}`);

/* ------------------------------------------------------------ self-check */

// A question whose answer also appears as the answer to a different question
// of the same archetype can be guessed from a sibling, and a question with a
// source that does not exist cannot be cited correctly. Both are generator
// bugs, and this is where they surface.
const problems = [];
const ids = new Set(Object.keys(fixtures).map((relative) => path.basename(relative, ".md")));
for (const question of questions) {
    for (const source of question.sources) {
        if (!ids.has(source)) {
            problems.push(`${question.id} cites a document that does not exist: ${source}`);
        }
    }

    if (question.sources.length === 0) {
        problems.push(`${question.id} has no sources`);
    }
}

// The whole point of the supersession questions is that the superseded value
// is still in the corpus. If a question's answer happens to equal the value
// it replaced, the question cannot tell the two readings apart.
const bodies = new Map([...rfcs.values()].map((rfc) => [rfc.id, `${JSON.stringify(rfc.header)}\n${rfc.body}`]));
for (const question of questions.filter((entry) => entry.archetype === "current-policy")) {
    const superseded = bodies.get(question.sources[0]) ?? "";
    if (superseded.includes(`**${question.answer} `)) {
        problems.push(`${question.id} answer ${question.answer} also appears as the superseded value`);
    }
}

for (const problem of problems) {
    console.error(problem);
}

process.exitCode = problems.length > 0 ? 1 : 0;
