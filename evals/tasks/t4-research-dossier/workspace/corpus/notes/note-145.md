# note-145 — load shedding: lower beacon

Id: note-145
Status: active

Notes from the load shedding covering the lower beacon path, recorded by
a capacity planner. Attendance was quorate and the agenda was taken in order.

## Dependencies

Attendees walked the dependency list and confirmed the lower beacon path still reports
through its usual rota. Its nearest neighbour on the call graph is the outer sweeper path,
which was reviewed separately and is not covered here. Neither path changed ownership this
period; the registry is the authority on that and was not amended.

## Timeouts and budgets

The default request timeout of 2500 ms was quoted during the session and nobody
proposed departing from it. Waivers were discussed in the abstract: a path with an approved
waiver uses the waiver, a path without one uses the default, and this note grants nothing.

The fan-out limit was mentioned in passing. It is documented in the RFC series and this note
does not restate the figure, because notes that restate figures go stale and this one would.

## Prior art

INC-111 came up as prior art. Nobody present owned it, and the report itself names only
the impacted path, so the owning team was not identified during the session. INC-018
was raised as a possible duplicate and left open.

## Follow-ups

Follow-ups were recorded against the owning team and will be picked up in the next load shedding.
Nothing in this note changes a policy: policy lives in the RFC series and is superseded there,
not here. Where this note and an RFC disagree, the RFC is right.
