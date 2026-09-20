# Incident review

`incidents/` holds this quarter's incident reports. Every one of them describes an
access-control lapse on one resource, reviewed alongside a second resource the same
change did not touch.

A report describes **data reaching somewhere it should not have** when the resource the
lapse happened to both held data at the time and could be reached from outside the
operator group. If the affected resource was empty, or could not be reached from
outside, then nothing left the boundary however serious the lapse was.

The facts that decide this are stated in each report, in different sections. Facts about
the second resource decide nothing.

Identify the reports of the first kind. Write `work/disclosures.json`.
