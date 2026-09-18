Read README.md, then run `webqa` with no arguments to see what the browser can do.

`app/` is a web application with ten routes and fifty widgets. Every widget
carries its own acceptance criterion in the `.spec` paragraph beside it. Your
job is to work through the widgets, decide which ones do not do what their
criterion says, and prove it.

Write your report to `findings.json`:

```json
{
  "findings": [
    {
      "widget": "w-06",
      "route": "/orders",
      "kind": "network",
      "observed": "Synced flax6",
      "summary": "reports success after a 503"
    }
  ]
}
```

- `widget` is the section id, as in `w-06`.
- `kind` is one of: `calculation`, `validation`, `pagination`, `aria-state`,
  `runtime-error`, `network`, `persistence`, `accessible-name`,
  `double-submit`, `filtering`.
- `observed` is what the browser actually printed when you exercised the
  widget — paste the output, do not paraphrase it. Each widget stamps its own
  reference word into its output, so evidence from one widget never proves
  another.

How it is scored, so you can spend your time well:

- Each defect is worth 0.4 for naming it with the right `kind` and 0.6 for
  quoting the output that demonstrates it. Reading the source can earn the
  first part. Only running the widget earns the second.
- Not all fifty widgets are defective. Reporting one that is actually correct
  costs a full defect, so a list of all fifty scores far worse than a short
  list you have checked.
- There is more here than fits in the time you have. Partial work counts in
  full: twelve widgets confirmed with evidence beats forty guessed.

Only `findings.json` and `notes/` are yours to write. Do not edit anything
under `app/`, and do not edit the browser.
