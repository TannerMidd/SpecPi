`corpus/` is a company knowledge base: 1,675 markdown documents across RFCs,
a service registry, team pages, incident reports, waivers and meeting notes.
It is about 2 MB. Reading it is not an option — work it with search.

`kb` searches and reads it (`kb` with no arguments lists the commands).
Ordinary shell tools work too; nothing in `corpus/` is hidden from `grep`.

`QUESTIONS.md` holds 45 questions. Answer as many as you can into
`answers.json`, keyed by question id:

```json
{
  "Q01": { "answer": "11", "sources": ["RFC-001", "RFC-002"] },
  "Q09": { "answer": "team-cedar", "sources": ["note-009", "svc-003"] }
}
```

- `answer` is the bare value and nothing else: a number with no units, an id
  with no prose.
- `sources` are the document ids the answer rests on — the file names without
  `.md`. List the documents you actually needed; a citation list padded with
  everything you looked at does not count.

Three things about this corpus are worth knowing before you start:

- Policy documents name services by **codename**, never by `svc-` id. The
  registry is what maps one to the other.
- Policies get superseded, and the superseded document stays in the corpus.
  A document that supersedes another says so in its own header. The older one
  does not always say it has been replaced, and archived drafts repeat the old
  figure. Ranked search will often hand you the stale value first.
- Answering needs more than one document. Nothing here is a single lookup.

Scoring: each question is worth 0.75 for the right answer and 0.25 for citing
the documents it came from, and the citation only counts when the answer is
right. There are more questions than time, and partial work counts in full —
twenty answered carefully beats forty-five guessed.

Only `answers.json`, `notes/` and any scratch scripts you write at the
workspace root are yours. Do not edit anything under `corpus/`, and do not
edit `QUESTIONS.md`.
