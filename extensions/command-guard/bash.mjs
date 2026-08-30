import { redactCommand } from "./redact.mjs";
import { analyze as analyzeCmd } from "./cmd.mjs";

export const BASH_LIMITS = Object.freeze({ maxInput: 128 * 1024, maxTokens: 4096, maxLeaves: 128, maxDepth: 8 });
const separators = new Set([";", "&&", "||", "|", "&", "(", ")"]);
const shells = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);
const wrappers = new Set(["sudo", "doas", "env", "command", "exec", "nohup", "nice", "time", "timeout", "chroot", "busybox", "toybox"]);

function heredocOpeners(line) {
  const found = []; let quote = "", escaped = false, comment = false;
  for (let index = 0; index < line.length - 1; index += 1) {
    const character = line[index];
    if (comment) break;
    if (escaped) { escaped = false; continue; }
    if (character === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (character === quote) quote = ""; continue; }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (character === "#" && (index === 0 || /[\s;|&()]/.test(line[index - 1]))) { comment = true; continue; }
    if (character !== "<" || line[index + 1] !== "<" || line[index + 2] === "<") continue;
    index += 2; let stripTabs = false;
    if (line[index] === "-") { stripTabs = true; index += 1; }
    while (line[index] === " " || line[index] === "\t") index += 1;
    let delimiter = "", wordQuote = "", wordEscaped = false, ansiSingle = false, unsupported = false;
    for (; index < line.length; index += 1) {
      const value = line[index];
      if (wordEscaped) { delimiter += value; wordEscaped = false; continue; }
      if (value === "$" && !wordQuote && (line[index + 1] === "'" || line[index + 1] === '"')) { wordQuote = line[index + 1]; ansiSingle = wordQuote === "'"; unsupported ||= wordQuote === '"'; index += 1; continue; }
      if (value === "\\" && ansiSingle) { unsupported = true; delimiter += value; continue; }
      if (value === "\\" && wordQuote !== "'") { wordEscaped = true; continue; }
      if (wordQuote) { if (value === wordQuote) { wordQuote = ""; ansiSingle = false; } else delimiter += value; continue; }
      if (value === "'" || value === '"') { wordQuote = value; continue; }
      if (/[\s;|&()<>]/.test(value)) break;
      delimiter += value;
    }
    if (delimiter && !unsupported) found.push({ delimiter, stripTabs });
  }
  return found;
}
export function stripHeredocBodies(input) {
  const lines = String(input).split(/(?<=\n)/), pending = [], output = [];
  for (const line of lines) {
    if (pending.length) {
      let candidate = line.replace(/[\r\n]+$/, "");
      if (pending[0].stripTabs) candidate = candidate.replace(/^\t+/, "");
      if (candidate === pending[0].delimiter) pending.shift();
      output.push(line.replace(/[^\r\n]/g, " ")); continue;
    }
    output.push(line); pending.push(...heredocOpeners(line));
  }
  return output.join("");
}

function token(text, kind = "word") { return { text, kind }; }
function scan(input, limits) {
  const tokens = [], redirects = [], dynamicConstructs = [], errors = [];
  let word = "", quote = "", escaped = false, comment = false, heredoc = false;
  const flush = () => { if (word) { tokens.push(token(word)); word = ""; } };
  const push = (text, kind) => { flush(); tokens.push(token(text, kind)); };
  for (let i = 0; i < input.length; i += 1) {
    const c = input[i], n = input[i + 1];
    if (comment) { if (c === "\n" || c === "\r") comment = false; else continue; }
    if (escaped) { word += c; escaped = false; continue; }
    if (c === "\\" && quote !== "'") {
      if (n === "\n") i += 1;
      else if (n === "\r" && input[i + 2] === "\n") i += 2;
      else if (quote === '"' && !/[\\$`"]/.test(n || "")) word += "\\";
      else escaped = true;
      continue;
    }
    if (quote) {
      if (c === quote) quote = "";
      else {
        if (quote === '"' && (c === "`" || c === "$" && (n === "(" || n === "{" || /[A-Za-z_0-9@*#?$!-]/.test(n || "")))) dynamicConstructs.push({ kind: "quoted-expansion", start: i, end: i + 1 });
        word += c;
      }
      continue;
    }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === "#" && !word && (i === 0 || /[\s;|&()]/.test(input[i - 1]))) { comment = true; continue; }
    if (c === "\r" || c === "\n") { if (c === "\r" && n === "\n") i += 1; push(";", "separator"); continue; }
    if (/\s/.test(c)) { flush(); continue; }
    if ((c === "<" || c === ">") && n === "(") {
      dynamicConstructs.push({ kind: "process-substitution", start: i, end: i + 1 });
      word += `${c}(`; i += 1; continue;
    }
    if (c === "<" || c === ">") {
      flush(); let op = c;
      if (n === c || n === "&" || n === "|") { op += n; i += 1; }
      if (/^[0-9]$/.test(input[i - 1] || "") && !word) op = `${input[i - 1]}${op}`;
      tokens.push(token(op, "redirect")); redirects.push(op);
      if (op.includes("<<")) dynamicConstructs.push({ kind: "heredoc" });
      continue;
    }
    if (c === ";" || c === "(" || c === ")" || c === "&" || c === "|") {
      flush(); let op = c;
      if ((c === "&" || c === "|") && n === c) { op += n; i += 1; }
      push(op, "separator"); continue;
    }
    if (c === "`" || (c === "$" && (n === "(" || n === "{"))) {
      dynamicConstructs.push({ kind: c === "`" ? "command-substitution" : "substitution", start: i, end: i + 1 });
      word += c; continue;
    }
    if (c === "$" && /[A-Za-z_0-9@*#?$!-]/.test(n || "")) {
      dynamicConstructs.push({ kind: "environment-expansion", start: i, end: i + 1 });
      word += c; continue;
    }
    word += c;
  }
  flush();
  if (quote || escaped) errors.push("unterminated quote or escape");
  if (tokens.length > limits.maxTokens) errors.push("token limit exceeded");
  return { tokens, redirects, dynamicConstructs, parseErrors: errors };
}

function leafFrom(words) {
  if (!words.length) return undefined;
  let start = 0;
  while (start < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start].text)) start += 1;
  const commandWords = words.slice(start);
  const first = commandWords[0];
  if (!first) return undefined;
  const executable = first.text;
  const dynamic = /[$`*?{}]/.test(executable) || executable.startsWith("-");
  return { shell: "bash", executable, operation: commandWords.slice(1).map((x) => x.text).join(" "), args: commandWords.slice(1).map((x) => x.text), redactedTarget: redactCommand(commandWords.slice(1).map((x) => x.text).join(" ")), dynamic };
}
function makeLeaves(tokens, limits) {
  const leaves = [], redirects = [], dynamicConstructs = [];
  let current = [], pendingRedirect, pendingSeparator;
  const flush = () => {
    const leaf = leafFrom(current);
    if (leaf) { leaf.separatorBefore = pendingSeparator; leaves.push(leaf); pendingSeparator = undefined; }
    current = [];
  };
  for (const item of tokens) {
    if (item.kind === "separator") { flush(); pendingSeparator = item.text; continue; }
    if (item.kind === "redirect") { pendingRedirect = item.text; continue; }
    if (pendingRedirect) {
      const detail = { operator: pendingRedirect, target: item.text, separatorBefore: pendingSeparator };
      redirects.push(detail);
      leaves.push({ shell: "bash", executable: "<redirect>", operation: `${pendingRedirect} ${item.text}`, args: [item.text], redactedTarget: redactCommand(item.text), redirect: pendingRedirect, separatorBefore: pendingSeparator });
      pendingRedirect = undefined;
      continue;
    }
    current.push(item);
  }
  flush();
  if (pendingRedirect) dynamicConstructs.push({ kind: "missing-redirect-target" });
  if (leaves.length > limits.maxLeaves) dynamicConstructs.push({ kind: "leaf-limit" });
  return { leaves: leaves.slice(0, limits.maxLeaves), redirects, dynamicConstructs };
}
function wrapperCommandIndex(name, args) {
  const rawTakesValue = name === "exec" ? new Set(["-a"])
    : name === "sudo" ? new Set(["-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt", "-c", "--close-from", "-t", "--command-timeout", "-d", "--chdir", "-r", "--chroot", "--role", "--type"])
    : name === "doas" ? new Set(["-u", "-c"])
      : name === "env" ? new Set(["-u", "--unset", "-c", "--chdir", "--argv0", "-s", "--split-string"])
        : name === "nice" ? new Set(["-n", "--adjustment"])
          : name === "time" ? new Set(["-f", "--format", "-o", "--output"])
            : name === "timeout" ? new Set(["-s", "--signal", "-k", "--kill-after"])
              : name === "chroot" ? new Set(["--userspec", "--groups"])
                : name === "xargs" ? new Set(["-E", "-I", "-L", "-n", "-P", "-s", "--eof", "--replace", "--max-lines", "--max-args", "--max-procs", "--max-chars", "--arg-file"])
                  : new Set();
  const takesValue = new Set([...rawTakesValue].map((option) => option.toLowerCase()));
  let skipPositional = name === "timeout" || name === "chroot";
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    if (name === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) continue;
    if (arg === "--") return index + 1 < args.length ? index + 1 : -1;
    const option = arg.toLowerCase();
    if (takesValue.has(option)) { index += 1; continue; }
    if ([...takesValue].some((entry) => entry.startsWith("--") ? option.startsWith(`${entry}=`) : option.startsWith(entry) && option.length > entry.length)) continue;
    if (arg.startsWith("-") && arg !== "-") continue;
    if (skipPositional) { skipPositional = false; continue; }
    return index;
  }
  return -1;
}
function addNested(leaves, options, dynamicConstructs, depth) {
  if (depth >= options.maxDepth) { dynamicConstructs.push({ kind: "depth-limit" }); return; }
  for (const leaf of [...leaves]) {
    const name = leaf.executable.toLowerCase().replace(/\.exe$/, "").split(/[\\/]/).pop();
    if ((shells.has(name) || name === "cmd") && leaf.args.some((arg) => /^-[a-z]*c[a-z]*$/i.test(arg) || /^\/(?:c|k)$/i.test(arg))) {
      const flag = leaf.args.findIndex((arg) => /^-[a-z]*c[a-z]*$/i.test(arg) || /^\/(?:c|k)$/i.test(arg));
      const nested = leaf.args[flag + 1];
      if (!nested || /[$`]/.test(nested)) { dynamicConstructs.push({ kind: "dynamic-nested-shell" }); continue; }
      const parsed = name === "cmd" ? analyzeCmd(nested, { ...options, depth: depth + 1 }) : analyze(nested, { ...options, depth: depth + 1 });
      leaf.nested = parsed;
      dynamicConstructs.push(...parsed.dynamicConstructs);
    }
    if (name === "eval" || name === "xargs") {
      dynamicConstructs.push({ kind: `${name}-wrapper` });
      const start = name === "xargs" ? wrapperCommandIndex(name, leaf.args || []) : 0;
      const payload = start >= 0 ? leaf.args.slice(start).join(" ") : "";
      if (!payload || /[$`]/.test(payload)) dynamicConstructs.push({ kind: `dynamic-${name}` });
      else {
        leaf.nested = analyze(payload, { ...options, depth: depth + 1 });
        dynamicConstructs.push(...leaf.nested.dynamicConstructs);
      }
    }
    if (wrappers.has(name)) {
      dynamicConstructs.push({ kind: `${name}-wrapper` });
      const commandIndex = wrapperCommandIndex(name, leaf.args || []);
      if (commandIndex < 0) { dynamicConstructs.push({ kind: `dynamic-${name}` }); continue; }
      const childArgs = leaf.args.slice(commandIndex);
      const child = leafFrom(childArgs.map((text) => token(text)));
      if (!child) { dynamicConstructs.push({ kind: `dynamic-${name}` }); continue; }
      leaf.nested = { shell: "bash", leaves: [child], redirects: [], dynamicConstructs: [], parseErrors: [], indeterminate: child.dynamic };
      addNested(leaf.nested.leaves, options, leaf.nested.dynamicConstructs, depth + 1);
      leaf.nested.indeterminate ||= leaf.nested.leaves.some((entry) => entry.dynamic) || leaf.nested.dynamicConstructs.some((item) => /limit|dynamic/.test(item.kind));
      dynamicConstructs.push(...leaf.nested.dynamicConstructs);
    }
    if (name === "find" && leaf.args.some((arg) => arg === "-exec" || arg === "-execdir" || arg === "-delete")) {
      dynamicConstructs.push({ kind: "find-exec" });
      const execIndex = leaf.args.findIndex((arg) => arg === "-exec" || arg === "-execdir");
      if (execIndex >= 0) {
        const payload = leaf.args.slice(execIndex + 1).filter((arg) => arg !== ";" && arg !== "+").join(" ");
        if (!payload || /[$`{}]/.test(payload)) dynamicConstructs.push({ kind: "dynamic-find-exec" });
        else { leaf.nested = analyze(payload, { ...options, depth: depth + 1 }); dynamicConstructs.push(...leaf.nested.dynamicConstructs); }
      }
    }
  }
}

export function analyze(input, options = {}) {
  const limits = { ...BASH_LIMITS, ...options };
  if (typeof input !== "string" || Buffer.byteLength(input, "utf8") > limits.maxInput) return { shell: "bash", leaves: [], redirects: [], dynamicConstructs: [{ kind: "input-limit" }], parseErrors: [], indeterminate: true };
  const parsedInput = stripHeredocBodies(input);
  const scanned = scan(parsedInput, limits);
  const made = makeLeaves(scanned.tokens, limits);
  const dynamicConstructs = [...scanned.dynamicConstructs, ...made.dynamicConstructs];
  const substitutionPattern = /(?:\$\(|<\(|`)\s*([^`()]*?)(?:\)|`)/g;
  let substitution;
  while ((substitution = substitutionPattern.exec(parsedInput))) {
    if ((options.depth || 0) >= limits.maxDepth) { dynamicConstructs.push({ kind: "depth-limit" }); break; }
    const nested = analyze(substitution[1], { ...options, depth: (options.depth || 0) + 1 });
    made.leaves.push(...nested.leaves);
    dynamicConstructs.push({ kind: "substitution-nested" }, ...nested.dynamicConstructs);
  }
  addNested(made.leaves, limits, dynamicConstructs, options.depth || 0);
  return { shell: "bash", leaves: made.leaves, redirects: made.redirects, dynamicConstructs, parseErrors: scanned.parseErrors, indeterminate: scanned.parseErrors.length > 0 || made.leaves.some((leaf) => leaf.dynamic) || dynamicConstructs.some((item) => /(?:input|token|leaf|depth)-limit|dynamic-|heredoc|substitution|expansion|missing-redirect/.test(item.kind)) };
}
export const analyzeBash = analyze;
