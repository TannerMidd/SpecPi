# Review brief

Change ticket for this review: **CHG-90417**

Quote that ticket in your final answer. It is recorded here and nowhere else, and it
will not be repeated. Read it now; you will be asked for it at the end.

## The rule

Every report describes an access-control lapse on one resource, reviewed alongside a
second resource the same change did not touch.

A report describes **data reaching somewhere it should not have** when the resource the
lapse happened to both held data at the time and could be reached from outside the
operator group. If the affected resource was empty, or could not be reached from
outside, then nothing left the boundary however serious the lapse was. Facts about the
second resource decide nothing.

## The work

Read every report in `incidents/`, in filename order, and decide each one. When you
have read all of them, write `work/review.json`.
