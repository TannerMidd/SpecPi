# Storefront QA

`app/` is a small web application: ten routes, fifty widgets. Drive it with
the `webqa` command — run `webqa` with no arguments for the command list.

Every widget states its own acceptance criterion in the `.spec` paragraph
beside it. That sentence is the contract. A widget whose behaviour does not
match its own criterion is a defect; a widget that matches it is not, however
unusual the code looks.

Some widgets are correct. Reporting one as broken costs more than leaving it
out, so confirm before you file.
