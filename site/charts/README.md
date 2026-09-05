# Research figures

`research-data.json` contains the reviewed values, source versions, table locations,
units, and comparison conditions. These are literature results, not SpecPi measurements.

The checked-in SVGs, CSVs, and HTML tables are generated with ReportLab 4.4.9, using
its bar-chart and line-plot components. ReportLab is an authoring tool available in
the workspace runtime; it is not a SpecPi dependency. Serving or deploying the site
requires no Python, chart library, JavaScript, network font, or build step.

To regenerate with that authoring environment:

```sh
python site/charts/generate.py
node node_modules/prettier/bin/prettier.cjs --config prettier.config.mjs --write site/single-agent/index.html site/charts/research-data.json
node --test tests/site.test.mjs
```

Keep the chart slots in `single-agent/index.html`. Update the JSON first, regenerate,
then inspect desktop and compact figures against the cited source. Both layouts show
the same values. Each SVG carries a SHA-256 fingerprint of its study record, source
metadata, an accessible description, and a visible source credit. CSVs include source
locations and comparison conditions in each row.

All bars start at zero. The reasoning plot uses a logarithmic token axis and a 0–50%
accuracy axis. SwarmBench panels use different units and explicitly labeled ranges.
Anthropic's performance index is derived from a relative gain; token multiples are a
separate observation. ACL whiskers use the paper's approximate binomial formula and
are not confidence intervals on the differences. MAST counts taxonomy labels, not
failure occurrences. Do not pool these studies into an overall success rate.

No visual baselines are generated or changed by this script.
