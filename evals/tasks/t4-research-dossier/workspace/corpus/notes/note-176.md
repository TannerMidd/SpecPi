# note-176 — runbook revision: lower beacon

Id: note-176
Status: active

Notes from the runbook revision covering the lower beacon path, recorded by
a platform reviewer. Attendance was quorate and the agenda was taken in order.

## Dependencies

Attendees walked the dependency list and confirmed the lower beacon path still reports
through its usual rota. Its nearest neighbour on the call graph is the rapid ingest path,
which was reviewed separately and is not covered here. Neither path changed ownership this
period; the registry is the authority on that and was not amended.

## Timeouts and budgets

The default request timeout of 2500 ms was quoted during the session and nobody
proposed departing from it. Waivers were discussed in the abstract: a path with an approved
waiver uses the waiver, a path without one uses the default, and this note grants nothing.

The batch ceiling was mentioned in passing. It is documented in the RFC series and this note
does not restate the figure, because notes that restate figures go stale and this one would.

## Prior art

INC-060 came up as prior art. Nobody present owned it, and the report itself names only
the impacted path, so the owning team was not identified during the session. INC-034
was raised as a possible duplicate and left open.

## Follow-ups

Follow-ups were recorded against the owning team and will be picked up in the next runbook revision.
Nothing in this note changes a policy: policy lives in the RFC series and is superseded there,
not here. Where this note and an RFC disagree, the RFC is right.
