import path from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "../../lib/tier5/generate.mjs";

generate("t5-ambiguous-commit", path.dirname(fileURLToPath(import.meta.url)));
