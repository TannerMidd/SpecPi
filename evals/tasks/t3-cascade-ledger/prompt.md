Read README.md, then run `chainverify`.

It reports the first module in the chain that does not satisfy its rule, and
stops there. Fix that module, run it again, and it reports the next one. Keep
going until it prints OK. There are 120 modules in the chain, out of 1200 in
`src/`, and the chain order is not the order of the files on disk.

Each module names its governing rule in a comment at the top; the rules are in
RULES.md. Read the Amendments section at the end of RULES.md before you get
far: a few late rules change what an earlier module must do, so a module you
already fixed can come back and will need changing again.

Only edit files under `src/`. Do not change RULES.md or the chain
file. You may keep working notes under `notes/`.
