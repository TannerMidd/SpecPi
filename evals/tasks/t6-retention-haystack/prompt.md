# Which of these incidents let data out?

`incidents/` holds twenty-eight incident reports. Each one describes an
access-control lapse on one resource, reviewed alongside a second resource the
same change did not touch.

A report describes **data reaching somewhere it should not have** when the
resource the lapse happened to *both*:

- held data at the time, and
- could be reached from outside the operator group.

If the affected resource was empty, or could not be reached from outside, then
nothing left the boundary however serious the lapse was. Facts about the second
resource decide nothing.

Write `work/disclosures.json`:

```json
{ "disclosures": ["INC-0000", "INC-0001"] }
```

`disclosures` is the sorted list of report ids of the first kind.

## Notes

- No keyword separates them. Every report contains a sentence saying a resource
  held data, one saying a resource held nothing, one saying a resource was
  reachable from outside and one saying a resource was not. Which resource each
  sentence is about is the whole question.
- The two sentences that decide a report are in different sections, with the
  rest of the report between them.
- The answer is scored exactly: a wrongly flagged report costs as much as a
  missed one.
- The reports are long and most of them are irrelevant once you have judged
  them. How much of them you are still carrying at the end is part of what is
  measured.
- Only `work/` is writable. Leave `incidents/` unchanged.
