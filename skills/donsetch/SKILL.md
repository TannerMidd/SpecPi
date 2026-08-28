---
name: donsetch
license: AGPL-3.0-only
description: Uses the DonSeTch CLI for multi-page site crawling, bot-wall or JavaScript-heavy page extraction, focused low-token URL reads, change checks, and keyless search. Use when ordinary pi-web-access fetching is insufficient or when a whole documentation site must be mapped or crawled.
compatibility: Requires the donsetch executable on PATH.
---

# DonSeTch CLI

Prefer Pi's `web_search`, `source_check`, and `fetch_content` tools for ordinary web research. Use DonSeTch through `bash` when you need site crawling, bot-wall escalation, browser actions, focused extraction, or cheap change/probe checks.

## Inspect available options

```bash
donsetch --help
donsetch fetch --help
donsetch search --help
donsetch crawl --help
```

## Search

```bash
donsetch search "query"
donsetch search "query" --intent code --max-results 10
donsetch search "query" --json
```

Search finds candidate URLs; fetch the best result afterward. Treat `weak=true` or low-consensus results cautiously.

## Fetch one or several pages

```bash
donsetch fetch 'https://example.com'
donsetch fetch 'https://example.com/long-doc' --focus 'error handling'
donsetch fetch 'https://example.com/long-doc' --toc
donsetch fetch 'https://example.com/long-doc' --section 'Authentication'
donsetch fetch 'https://example.com' --must-contain 'required phrase'
donsetch fetch 'https://example.com' --since-last
donsetch fetch 'https://a.example/x' 'https://b.example/y' --budget-tokens 2000
```

Choose the cheapest useful mode:

- Verification only: `--must-contain`.
- Unknown long-page structure: `--toc`, then `--section`.
- Known topic: `--focus`.
- Changed since last read: `--since-last`.
- Full article pagination: `--stitch`.
- Structured parsing: `--json` and process with `jq`.

For JavaScript-only pages, pass deterministic browser actions:

```bash
donsetch fetch 'https://example.com/search' \
  --actions '[{"do":"type","selector":"input[q]","text":"query"},{"do":"press","key":"Enter"},{"do":"wait_text","text":"results"}]'
```

## Crawl a site

```bash
donsetch crawl 'https://docs.example.com' --mode map
donsetch crawl 'https://docs.example.com' --topic 'authentication' --max-pages 20
donsetch crawl 'https://docs.example.com' --topic 'API reference' --max-pages 30 --deadline 300
donsetch crawl 'https://docs.example.com' --resume '<resume-token>'
```

Always set `--topic` for a focused crawl. Start with `--mode map` when site structure is unknown. Bound work with `--max-pages`, `--max-chars`, and `--deadline`. Resume partial crawls instead of restarting.

## Operational rules

- Quote URLs and user-provided arguments.
- Use `--json` when downstream code must parse results.
- Redirect large output to a temporary file and inspect bounded slices rather than flooding model context.
- Respect robots.txt; do not use `--no-robots` unless the user explicitly authorizes it.
- Exit code 2 is transient and may be retried; exit code 3 indicates a wall and usually requires another source or fetch strategy.
