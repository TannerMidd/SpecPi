import { redactCommand } from "./redact.mjs";

export const CMD_LIMITS = Object.freeze({ maxInput: 128 * 1024, maxTokens: 4096, maxLeaves: 128, maxDepth: 8 });
function lex(input, limits) {
  const tokens = [], errors = [], dynamicConstructs = [], redirects = [];
  let word = "", quote = false, caret = false;
  const flush = () => { if (word) { tokens.push(word); word = ""; } };
  for (let i = 0; i < input.length; i += 1) {
    const c = input[i], n = input[i + 1];
    if (caret) { word += c; caret = false; continue; }
    if (c === "^" && !quote) { caret = true; continue; }
    if (c === '"') { quote = !quote; continue; }
    if (!quote && (c === "&" || c === "|" || c === ">" || c === "<" || c === "(" || c === ")")) {
      flush(); let op = c;
      if ((c === "&" || c === "|") && n === c) { op += n; i += 1; }
      if (c === ">" && n === ">") { op += n; i += 1; }
      tokens.push(op); if (c === ">" || c === "<") redirects.push(op); continue;
    }
    if (!quote && /\s/.test(c)) { flush(); continue; }
    word += c;
  }
  flush();
  if (quote || caret) errors.push("unterminated quote or caret");
  if (tokens.length > limits.maxTokens) errors.push("token limit exceeded");
  for (const value of tokens) {
    if (/%[^%\s]+%|![^!\s]+!/.test(value)) dynamicConstructs.push({ kind: "environment-expansion" });
  }
  return { tokens, errors, dynamicConstructs, redirects };
}
function unwrap(tokens) {
  const leaves = [], redirects = []; let current = [], pendingSeparator, pendingRedirect;
  const flush = () => {
    if (current.length) {
      const executable = current[0].replace(/^@+/, "");
      leaves.push({ shell: "cmd", executable, operation: current.slice(1).join(" "), args: current.slice(1), redactedTarget: redactCommand(current.slice(1).join(" ")), dynamic: /[%!]/.test(executable), separatorBefore: pendingSeparator });
      pendingSeparator = undefined; current = [];
    }
  };
  for (const value of tokens) {
    if (["&", "&&", "||", "|", "(", ")"].includes(value)) { flush(); pendingSeparator = value; }
    else if (value === ">" || value === ">>" || value === "<") pendingRedirect = value;
    else if (pendingRedirect) { redirects.push({ operator: pendingRedirect, target: value }); leaves.push({ shell: "cmd", executable: "<redirect>", operation: `${pendingRedirect} ${value}`, args: [value], redactedTarget: redactCommand(value), redirect: pendingRedirect, separatorBefore: pendingSeparator }); pendingRedirect = undefined; }
    else current.push(value);
  }
  flush();
  return { leaves, redirects, missingRedirect: Boolean(pendingRedirect) };
}
export function analyze(input, options = {}) {
  const limits = { ...CMD_LIMITS, ...options };
  if (typeof input !== "string" || Buffer.byteLength(input, "utf8") > limits.maxInput) return { shell: "cmd", leaves: [], redirects: [], dynamicConstructs: [{ kind: "input-limit" }], parseErrors: [], indeterminate: true };
  const result = lex(input, limits), unwrapped = unwrap(result.tokens), leaves = unwrapped.leaves;
  const dynamicConstructs = [...result.dynamicConstructs];
  if (unwrapped.missingRedirect) dynamicConstructs.push({ kind: "missing-redirect-target" });
  for (const leaf of leaves) {
    const n = leaf.executable.toLowerCase().split(/[\\/]/).pop();
    if (n === "cmd" || n === "cmd.exe") {
      const flag = leaf.args.findIndex((arg) => /^\/(?:c|k)$/i.test(arg));
      const payload = flag >= 0 ? leaf.args.slice(flag + 1).join(" ") : "";
      if (!payload || /[%!]/.test(payload) || (options.depth || 0) >= limits.maxDepth) dynamicConstructs.push({ kind: "dynamic-nested-cmd" });
      else { leaf.nested = analyze(payload, { ...options, depth: (options.depth || 0) + 1 }); dynamicConstructs.push({ kind: "nested-cmd" }, ...leaf.nested.dynamicConstructs); }
    } else if (n === "start") {
      const cmdIndex = leaf.args.findIndex((arg) => /(?:^|[\\/])cmd(?:\.exe)?$/i.test(arg));
      if (cmdIndex < 0 || (options.depth || 0) >= limits.maxDepth) dynamicConstructs.push({ kind: "dynamic-start" });
      else { leaf.nested = analyze(leaf.args.slice(cmdIndex).join(" "), { ...options, depth: (options.depth || 0) + 1 }); dynamicConstructs.push({ kind: "nested-start-cmd" }, ...leaf.nested.dynamicConstructs); }
    } else if (n === "call") {
      const payload = leaf.args.join(" ");
      if (!payload || /[%!]/.test(payload) || (options.depth || 0) >= limits.maxDepth) dynamicConstructs.push({ kind: "dynamic-call" });
      else { leaf.nested = analyze(payload, { ...options, depth: (options.depth || 0) + 1 }); dynamicConstructs.push({ kind: "nested-call" }, ...leaf.nested.dynamicConstructs); }
    } else if (n === "for") dynamicConstructs.push({ kind: "dynamic-for" });
    else if (["wmic", "mshta", "rundll32", "regsvr32"].includes(n)) dynamicConstructs.push({ kind: `dynamic-${n}` });
    if (n.endsWith(".bat") || n.endsWith(".cmd")) dynamicConstructs.push({ kind: "batch-file" });
  }
  if (leaves.length > limits.maxLeaves) dynamicConstructs.push({ kind: "leaf-limit" });
  return { shell: "cmd", leaves: leaves.slice(0, limits.maxLeaves), redirects: unwrapped.redirects, dynamicConstructs, parseErrors: result.errors, indeterminate: result.errors.length > 0 || dynamicConstructs.some((item) => /dynamic|batch|limit|missing|expansion/.test(item.kind)) || leaves.some((leaf) => leaf.dynamic || leaf.nested?.indeterminate) };
}
export const analyzeCmd = analyze;
