# Review sixty reports and remember the brief

Read `BRIEF.md` first. It records the change ticket for this review, once, and
states the rule you are applying.

Then read every report in `incidents/`, in filename order, and decide each one.

Write `work/review.json`:

```json
{ "ticket": "CHG-00000", "disclosures": ["INC-0000"], "reviewed": 60 }
```

- `ticket` is the change ticket from the brief.
- `disclosures` is the sorted list of report ids describing data reaching
  somewhere it should not have.
- `reviewed` is how many reports you read.

## Notes

- The ticket appears in the brief and nowhere else. It will not be repeated.
- These reports do not fit in a context window all at once. What survives when
  the session has to make room is the point of the exercise.
- No keyword separates a report that let data out from one that did not. Every
  report contains a sentence saying a resource held data, one saying a resource
  held nothing, one saying a resource was reachable from outside and one saying
  a resource was not. Which resource each sentence is about is the question, and
  the two that decide a report sit in different sections.
- The answer is scored exactly: a wrongly flagged report costs as much as a
  missed one.
- Only `work/` is writable. Leave `incidents/` and `BRIEF.md` unchanged.
