// Prose that has to be read to be understood, for the tier 6 tasks that need a long session.
//
// Two earlier versions of this file failed, and both failures are worth keeping written down
// because the second one looked nothing like the first.
//
// v1 failed on batching: every task could be collapsed into a shell one-liner, so Pi answered a
// sixty-step walk with sixty-one reads inside ten model requests and the advisor was consulted once
// across the whole tier.
//
// v2 failed on vocabulary. The events were written in shared language and the severity was pinned
// to SEV2 so skimming could not sort on it -- and then the remedies were split into two pools, one
// for outages and one for disclosures. `grep -liE 'revoked|purged|allowlisted|re-scoped'` returned
// the answer set exactly, on both tasks, with no false positives. The front door was locked and the
// back door was left open, and nothing in the build checked for a back door.
//
// So v3 changes the shape of the problem rather than the wording. A report's class is not carried
// by any sentence it contains. Every report contains the same four determining sentences:
//
//   content-present   the resource held that day's data when the window opened
//   content-absent    the resource held nothing, because the load had failed
//   reach-open        the resource answers through the public edge
//   reach-closed      the resource answers only inside the VPC boundary
//
// What differs is which resource each sentence is about. Every report names a subject resource --
// the one the lapse happened to -- and a second resource that was merely reviewed alongside it. The
// report describes data as having reached somewhere it should not have exactly when the subject
// both held data and was reachable. The other two sentences are true of the second resource and
// decide nothing.
//
// That makes the class a fact about binding rather than about words. The multiset of sentences is
// identical across every report in the corpus; a term-frequency attack has nothing to find, which
// `audit.mjs` asserts rather than assumes. Both resources are drawn from one pool, so the names
// carry no signal either, and the two determining sentences sit in different sections with the
// filler between them so that no local window contains both.
//
// The words v2 leaked through -- revoked, purged, allowlisted, re-scoped -- are deliberately in the
// single shared remedy pool now, appearing in both classes at the same rate. The attack that broke
// the last version is a term the audit now watches on every build.

/**
 * The resources a lapse can happen to.
 *
 * Every one of them holds something a customer would mind losing, so which resource a report is
 * about says nothing about its class. A pool where some entries were innocuous would hand back the
 * shortcut this file exists to remove: the resource name would become the keyword.
 */
const RESOURCES = [
    { name: "invoice-export bucket", data: "the day's exported invoices" },
    { name: "subscriber-archive bucket", data: "subscriber names and email addresses" },
    { name: "sessions debug endpoint", data: "session records including bearer tokens" },
    { name: "support-log index", data: "raw request bodies from support tickets" },
    { name: "telemetry-archive bucket", data: "device telemetry keyed to named accounts" },
    { name: "billing-extract share", data: "the month's billing extracts" },
    { name: "audit-trail mirror", data: "audit rows naming individual users" },
    { name: "crash-dump store", data: "crash dumps carrying request payloads" },
];

/** Every report has a lapse. The lapse is what makes exposure possible; it is never what decides it. */
const LAPSES = [
    "left readable without authentication after a policy edit",
    "opened to every tenant in the account rather than its own",
    "granted a policy permitting anonymous listing",
    "left with its ACL widened and its access log disabled",
    "shared into the contractor tenant by an unrelated change",
    "left accepting unauthenticated connections after a restart",
];

// The four determining sentences. Each is written twice, once per polarity, and the two readings
// share their vocabulary as closely as the meaning allows: both content lines name the data and the
// 02:40 load, both reach lines end on "reachable from outside the operator group". Every report
// carries all four, so none of these strings can separate anything.
const CONTENT_PRESENT = [
    (r) => `When the window opened, the ${r.name} held ${r.data}; the 02:40 load had completed normally.`,
    (r) => `The 02:40 load into the ${r.name} completed normally, so ${r.data} was in place throughout.`,
    (r) => `${capitalise(r.data)} was present in the ${r.name} for the whole window; that night's load had finished.`,
    (r) => `Nothing had interrupted the nightly load, so the ${r.name} was carrying ${r.data} by 03:00.`,
    (r) => `The ${r.name} was populated as usual that night and still held ${r.data} when the change landed.`,
    (r) => `The manifest confirms that ${r.data} had been written into the ${r.name} before midnight.`,
    (r) => `That night's run left ${r.data} sitting in the ${r.name}, as it does every night.`,
    (r) => `The ${r.name} was not empty: ${r.data} had loaded on schedule and was still there.`,
    (r) => `Object counts for the ${r.name} matched the expected total, so ${r.data} was present.`,
    (r) => `By the time of the change the ${r.name} already contained ${r.data} from the 02:40 run.`,
    (r) => `The loader reported success for the ${r.name}, and ${r.data} remained in place all morning.`,
    (r) => `${capitalise(r.data)} had arrived in the ${r.name} hours earlier and was untouched during the window.`,
];

const CONTENT_ABSENT = [
    (r) => `When the window opened, the ${r.name} held nothing; the 02:40 load had failed and wrote no ${r.data}.`,
    (r) => `The 02:40 load into the ${r.name} failed, so ${r.data} was never written and it stayed empty.`,
    (r) => `No ${r.data} was present in the ${r.name} at any point; that night's load had aborted.`,
    (r) => `The nightly load had been interrupted, so the ${r.name} was carrying no ${r.data} by 03:00.`,
    (r) => `The ${r.name} was not populated that night and held no ${r.data} when the change landed.`,
    (r) => `The manifest confirms that no ${r.data} had been written into the ${r.name} before midnight.`,
    (r) => `That night's run left the ${r.name} empty, which it does whenever the feed is late.`,
    (r) => `The ${r.name} was empty: ${r.data} had not loaded, and the retry was still queued.`,
    (r) => `Object counts for the ${r.name} were zero, so no ${r.data} was present.`,
    (r) => `By the time of the change the ${r.name} still contained no ${r.data} from the 02:40 run.`,
    (r) => `The loader reported failure for the ${r.name}, and ${r.data} never arrived that morning.`,
    (r) => `${capitalise(r.data)} had not reached the ${r.name} at all, the feed having stalled upstream.`,
];

const REACH_OPEN = [
    (r) =>
        `The ${r.name} answers through the public edge, so anything held in it was reachable from outside the operator group.`,
    (r) =>
        `Requests to the ${r.name} are served by the public edge; whatever it held was reachable from outside the operator group.`,
    (r) =>
        `Because the ${r.name} sits on the public edge, its contents were reachable from outside the operator group.`,
    (r) =>
        `The ${r.name} is published through the internet-facing gateway, putting its contents within reach of anyone outside the operator group.`,
    (r) =>
        `Routing for the ${r.name} goes out through the edge listener, so callers outside the operator group could reach it.`,
    (r) =>
        `The ${r.name} has an external address and resolves publicly, so its contents were within reach from outside the operator group.`,
    (r) => `Anyone outside the operator group could address the ${r.name} directly during the window.`,
    (r) =>
        `The ${r.name} is exposed at the perimeter rather than behind it, so its contents could be reached from outside the operator group.`,
    (r) =>
        `Traffic to the ${r.name} does not have to originate inside the network, so outsiders could reach whatever it held.`,
    (r) =>
        `The perimeter allows inbound requests to the ${r.name}, placing its contents in reach of callers outside the operator group.`,
    (r) => `The ${r.name} was on the public side of the boundary for the whole window.`,
    (r) => `Reaching the ${r.name} from outside the operator group required nothing more than its address.`,
];

const REACH_CLOSED = [
    (r) =>
        `The ${r.name} answers only inside the VPC boundary, so nothing held in it was reachable from outside the operator group.`,
    (r) =>
        `Requests to the ${r.name} never leave the VPC boundary; whatever it held stayed unreachable from outside the operator group.`,
    (r) =>
        `Because the ${r.name} sits behind the VPC boundary, its contents were not reachable from outside the operator group.`,
    (r) =>
        `The ${r.name} is published only through the internal gateway, keeping its contents out of reach of anyone outside the operator group.`,
    (r) =>
        `Routing for the ${r.name} stays on the internal listener, so callers outside the operator group could not reach it.`,
    (r) =>
        `The ${r.name} has no external address and does not resolve publicly, so its contents stayed out of reach from outside the operator group.`,
    (r) => `Nobody outside the operator group could address the ${r.name} directly at any point in the window.`,
    (r) =>
        `The ${r.name} is deployed behind the perimeter rather than at it, so its contents could not be reached from outside the operator group.`,
    (r) => `Traffic to the ${r.name} must originate inside the network, so outsiders could not reach whatever it held.`,
    (r) =>
        `The perimeter denies inbound requests to the ${r.name}, keeping its contents out of reach of callers outside the operator group.`,
    (r) => `The ${r.name} was on the internal side of the boundary for the whole window.`,
    (r) => `Reaching the ${r.name} from outside the operator group was not possible with any credential.`,
];

/**
 * Filler, and the reason there is so much of it.
 *
 * The two sentences that decide a report sit in different sections with this between them, so a
 * reader cannot decide from one window and a chunker cannot keep the decisive pair by accident. The
 * lines are written in the same register as the rest and several of them are near-misses -- they
 * talk about tokens, exposure and access without bearing on whether data moved.
 */
const NOISE = [
    "The on-call engineer paged the platform team at 04:12 and the bridge was open by 04:20.",
    "Credentials for the runbook host had rotated the previous week, which slowed the first responder.",
    "A deploy token was regenerated during the incident as a precaution, though it was not implicated.",
    "The token bucket limiter behaved as designed and shed load evenly across tenants.",
    "A secrets sync job ran on schedule during the window and completed normally.",
    "Authentication latency rose with everything else and recovered with everything else.",
    "The team reviewed the permission model afterwards and found it unchanged since the last audit.",
    "Retries were capped per request rather than per attempt, which held the blast radius steady.",
    "Dashboards for the affected region lagged by about ninety seconds throughout the window.",
    "The change that opened the window had passed review with two approvals.",
    "A connection pool sized for the old traffic shape saturated briefly at the morning peak.",
    "Garbage collection pauses grew once the working set crossed the heap sizing assumption.",
    "One replica reported clock skew of four seconds and was drained before it dropped its leases.",
    "The parser spent an unusual amount of time on a single malformed user agent string.",
    "An unrelated migration held a table lock for nine minutes near the end of the window.",
    "The health check probed a path that had been retired two releases earlier.",
    "Queue depth fell steadily once the backlog drained and the autoscaler stopped reacting.",
    "A cache stampede followed the nightly eviction and the origin absorbed it without shedding.",
    "Ownership of the component had moved between teams the previous quarter.",
    "The incident channel recorded forty-one messages, of which six were status updates.",
];

/**
 * Remedies, in one pool for every report regardless of class.
 *
 * This is the file's single most important list. In v2 it was two lists, and the security-incident
 * vocabulary in the disclosure half -- revoked, purged, allowlisted, re-scoped -- separated the
 * answer set perfectly under one grep. Those exact words live here now, in the pool every report
 * draws from, so the term that broke the last corpus is uniform across this one.
 */
const REMEDIES = [
    "The policy was reverted within the hour and every object under the prefix was re-scoped.",
    "The endpoint was removed rather than gated, and the tokens visible in the window were revoked.",
    "The destination is now allowlisted, and a policy check blocks anonymous access in this account.",
    "The log index was purged of matching records and key rotation was requested downstream.",
    "An alert now fires on the saturation signal rather than on the symptom it produces.",
    "The configuration key is validated at boot and the service refuses to start without it.",
    "Access review for this account moved from quarterly to weekly, with the diff posted publicly.",
    "The runbook now names the dashboard first and the log query second.",
];

/** Impact, written about the disruption rather than about the data, so it decides nothing either. */
const IMPACT = [
    "Requests from a minority of tenants failed or were slow for the duration of the window.",
    "Two downstream consumers retried through the window and reported no lasting effect.",
    "The customer-facing error rate peaked at a little under four percent and recovered fully.",
    "No tenant reported a problem before the alert fired, and three reported one afterwards.",
];

/**
 * How a report says which resource the lapse happened to.
 *
 * Eight phrasings rather than one, and four of them name the unaffected resource first, because a
 * single template makes the subject recoverable with a single regex -- and the subject is the one
 * thing a scripted attack needs. A parser written against this pool has to cover eight shapes and
 * resolve "the latter" and "the first of these" before it can even begin on the twenty-four ways
 * the determining sentences state their polarity.
 *
 * That is the honest position: this raises the cost of scripting the corpus well above the cost of
 * reading it, and it does not make scripting impossible. Nothing generated from pools could.
 */
const SUMMARIES = [
    (s, o, lapse) => [
        `The lapse in this incident was on the ${s.name}, which was ${lapse}.`,
        `The review also covered the ${o.name}, which the same change did not touch.`,
    ],
    (s, o, lapse) => [
        `The ${o.name} appears in this report only because it was reviewed at the same time.`,
        `What went wrong is that the ${s.name} was ${lapse}.`,
    ],
    (s, o, lapse) => [
        `Reviewers examined the ${o.name} and the ${s.name} during this incident.`,
        `Only the latter was affected: it was ${lapse}.`,
    ],
    (s, o, lapse) => [
        `Two resources were in scope. The ${o.name} was unaffected throughout.`,
        `The ${s.name} was ${lapse}.`,
    ],
    (s, o, lapse) => [
        `The incident is recorded against the ${s.name}, which was ${lapse}.`,
        `The ${o.name} shares an owner and was checked at the same time; the change did not reach it.`,
    ],
    (s, o, lapse) => [
        `Nothing was wrong with the ${o.name}, which was inspected as a precaution.`,
        `The fault was with the ${s.name}, which was ${lapse}.`,
    ],
    (s, o, lapse) => [
        `During the window the ${s.name} was ${lapse}.`,
        `The ${o.name}, inspected alongside it, was not affected by the change.`,
    ],
    (s, o, lapse) => [
        `This review covered the ${o.name} and the ${s.name}. The first of these came through clean.`,
        `The second was ${lapse}.`,
    ],
];

function capitalise(value) {
    return value.charAt(0).toUpperCase() + value.slice(1);
}

const SECTIONS = ["Summary", "Timeline", "Contributing factors", "Customer impact", "What we changed"];

/**
 * One incident report.
 *
 * `disclosure` is the ground truth: the subject resource both held data and was reachable. The
 * caller decides it; nothing about how the report is written follows from it except which of the
 * four determining sentences attaches to the subject and which to the resource reviewed beside it.
 *
 * The padding is load-bearing. A report has to be large enough that carrying all of them to the end
 * of the session costs real context, because that cost is what the marathon measures.
 */
export function report({ id, disclosure, next, paragraphs = 14 }) {
    const subject = next(RESOURCES);
    // Drawn from the same pool and never equal to the subject. A second pool would make the pairing
    // itself a signal, which is the same defect as a second remedy pool in a different coat.
    const other = next(RESOURCES.filter((entry) => entry.name !== subject.name));
    const lapse = next(LAPSES);

    // The binding. A disclosure is a subject that held data and could be reached; every other report
    // fails exactly one of those, and the sentence it fails on goes to the other resource instead,
    // so the four sentences are present either way.
    const subjectHasData = disclosure ? true : next([true, false]);
    const subjectReachable = disclosure ? true : !subjectHasData ? next([true, false]) : false;

    const contentFor = (resource, present) => next(present ? CONTENT_PRESENT : CONTENT_ABSENT)(resource);
    const reachFor = (resource, open) => next(open ? REACH_OPEN : REACH_CLOSED)(resource);

    const contentLine = contentFor(subject, subjectHasData);
    const reachLine = reachFor(subject, subjectReachable);
    const timeline = [
        contentLine,
        contentFor(other, !subjectHasData),
        // Which resource is described first varies, so "the first one mentioned is the subject" is
        // not a rule a script can lean on.
    ];
    const factors = [reachLine, reachFor(other, !subjectReachable)];
    if (next([true, false])) {
        timeline.reverse();
    }

    if (next([true, false])) {
        factors.reverse();
    }

    const lines = [
        `# Incident ${id}`,
        "",
        // Constant across the corpus. Severity is the first thing a skimmer sorts on, and letting it
        // track the answer would turn a reading task back into a lookup.
        "Severity: SEV2",
        `Duration: ${20 + (id.charCodeAt(id.length - 1) % 90)} minutes`,
        "",
    ];

    for (const section of SECTIONS) {
        lines.push(`## ${section}`, "");
        if (section === "Summary") {
            for (const line of next(SUMMARIES)(subject, other, lapse)) {
                lines.push(line, "");
            }

            // Constant across the corpus, so it carries nothing, and it keeps the ground truth
            // defensible: the rule is stated in every report as well as in the brief.
            lines.push(
                "Whether anything actually left the boundary is a question about what the affected",
                "resource held at the time and where it answers from; both are recorded below.",
                "",
            );
        }

        // The decisive pair is split across two sections with the filler between them.
        const facts = section === "Timeline" ? timeline : section === "Contributing factors" ? factors : [];
        for (const fact of facts) {
            lines.push(fact, "");
        }

        if (section === "Customer impact") {
            lines.push(next(IMPACT), "");
        } else if (section === "What we changed") {
            lines.push(next(REMEDIES), "");
        }

        for (let i = 0; i < paragraphs; i += 1) {
            lines.push(next(NOISE), "");
        }
    }

    // Returned alongside the text so the build can check that what was written actually encodes
    // what the answer key claims. A generator that bound a sentence to the wrong resource would
    // otherwise produce an unsolvable corpus that every harness fails for reasons nobody could see.
    return {
        text: lines.join("\n"),
        truth: {
            subject: subject.name,
            other: other.name,
            hasData: subjectHasData,
            reachable: subjectReachable,
            disclosure: subjectHasData && subjectReachable,
            sentences: { content: contentLine, reach: reachLine },
        },
    };
}

/**
 * Everything the generator could have chosen, for the audit and for the reference key.
 *
 * The key needs the sentence builders, not just the word lists: it recovers a report's label by
 * regenerating every sentence this file could have written and finding which ones are actually in
 * the text. That is a stronger reference solver than a stored answer, because it fails if the
 * corpus stops encoding the rule -- which is the failure mode a stored answer cannot see.
 */
export const POOLS = Object.freeze({
    RESOURCES,
    LAPSES,
    NOISE,
    REMEDIES,
    IMPACT,
    SUMMARIES,
    CONTENT_PRESENT,
    CONTENT_ABSENT,
    REACH_OPEN,
    REACH_CLOSED,
});
