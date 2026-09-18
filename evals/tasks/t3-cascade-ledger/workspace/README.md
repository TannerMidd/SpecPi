# Transform modules

`src/` holds 1200 modules. Each exports `apply(value)` and each names
the rule that governs it in a comment at the top. The rules are in `RULES.md`.

Some modules do not satisfy their rule. Run:

    chainverify

It reports the first module that is wrong and stops. It talks to a build
service that is not always up; if it fails, that is transient, so try again. Fix that module, run it
again, and it reports the next one. It never reports more than one at a time,
and the order is not the order of the files on disk.

Read the Amendments section of `RULES.md`. A few late rules change what an
earlier module must do, so a module you already fixed can come back.
