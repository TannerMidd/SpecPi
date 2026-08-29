/**
 * ZenPi Files — a dependency-free, Tea House-native project browser.
 *
 * /files [path] opens a compact tree, themed source/Markdown viewer,
 * git diff view, and line-comment workflow without external renderers.
 */

import path from "node:path";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
  getLanguageFromPath,
  getMarkdownTheme,
  highlightCode,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  Markdown,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import {
  buildFileTree,
  discoverProject,
  flattenFileTree,
  formatReviewMessage,
  readGitDiff,
  readTextFile,
  resolveBrowserRoot,
  sanitizeTerminalText,
} from "./core.mjs";

type Screen = "tree" | "file";
type InputMode = "normal" | "search" | "select" | "comment";

type TreeNode = {
  name: string;
  relativePath: string;
  absolutePath: string;
  parent?: TreeNode;
  directory: boolean;
  children?: TreeNode[];
  status?: string;
  changed: boolean;
};

type Snapshot = ReturnType<typeof discoverProject>;
type TreeRow = { node: TreeNode; depth: number };

const DEFAULT_HEIGHT = 20;
const MIN_HEIGHT = 8;
const MAX_HEIGHT = 40;

function compactHome(filePath: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return filePath;
  if (filePath === home) return "~";
  return filePath.startsWith(`${home}${path.sep}`) ? `~${filePath.slice(home.length)}` : filePath;
}

function printableInput(data: string): string {
  if (!data || data.includes("\x1b")) return "";
  return [...data].filter((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code >= 32 && (code < 127 || code > 159);
  }).join("");
}

function borderLine(
  left: string,
  right: string,
  label: string,
  width: number,
  theme: Theme,
  color: "borderAccent" | "borderMuted" = "borderMuted",
): string {
  if (width <= 1) return theme.fg(color, "─".repeat(Math.max(0, width)));
  const middleWidth = width - 2;
  const title = truncateToWidth(label, middleWidth, "");
  const fill = "─".repeat(Math.max(0, middleWidth - visibleWidth(title)));
  return theme.fg(color, `${left}${title}${fill}${right}`);
}

function framedRow(content: string, width: number, theme: Theme, selected = false): string {
  if (width <= 2) return truncateToWidth(content, width, "");
  const innerWidth = width - 4;
  const clipped = truncateToWidth(content, innerWidth, "");
  const padded = `${clipped}${" ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)))}`;
  const body = selected ? theme.bg("selectedBg", padded) : padded;
  return `${theme.fg("borderMuted", "│")} ${body} ${theme.fg("borderMuted", "│")}`;
}

function statusLabel(status: string | undefined, theme: Theme): string {
  if (!status) return "";
  if (status === "??") return theme.fg("dim", " ?");
  if (status.includes("D")) return theme.fg("error", " D");
  if (status.includes("A")) return theme.fg("success", " A");
  return theme.fg("warning", " M");
}

function diffLine(line: string, theme: Theme): string {
  const safe = sanitizeTerminalText(line);
  if (safe.startsWith("+++ ") || safe.startsWith("--- ")) return theme.fg("muted", safe);
  if (safe.startsWith("+")) return theme.fg("toolDiffAdded", safe);
  if (safe.startsWith("-")) return theme.fg("toolDiffRemoved", safe);
  if (safe.startsWith("@@")) return theme.fg("accent", safe);
  return theme.fg("toolDiffContext", safe);
}

class ZenFilesComponent implements Component {
  private snapshot: Snapshot;
  private root: TreeNode;
  private expanded = new Set<string>();
  private rows: TreeRow[] = [];
  private selected = 0;
  private scroll = 0;
  private screen: Screen = "tree";
  private mode: InputMode = "normal";
  private query = "";
  private changedOnly = false;
  private height = DEFAULT_HEIGHT;
  private file?: TreeNode;
  private raw = "";
  private rawLines: string[] = [];
  private fileError = "";
  private diffMode = false;
  private markdownMode = false;
  private selectionAnchor = 0;
  private selectionCursor = 0;
  private comment = "";
  private renderWidth = 80;
  private renderedCache?: { width: number; kind: string; lines: string[] };

  constructor(
    private readonly initialRoot: string,
    private theme: Theme,
    private readonly requestRender: () => void,
    private readonly close: () => void,
    private readonly notify: (message: string, level: "info" | "warning" | "error" | "success") => void,
    private readonly sendComment: (message: string) => void,
  ) {
    this.snapshot = discoverProject(initialRoot);
    this.root = buildFileTree(this.snapshot) as TreeNode;
    this.refreshRows();
  }

  private refreshRows(): void {
    this.rows = flattenFileTree(this.root, this.expanded, this.query, this.changedOnly) as TreeRow[];
    this.selected = Math.max(0, Math.min(this.selected, Math.max(0, this.rows.length - 1)));
  }

  private reloadTree(): void {
    const selectedPath = this.rows[this.selected]?.node.relativePath;
    this.snapshot = discoverProject(this.initialRoot);
    this.root = buildFileTree(this.snapshot) as TreeNode;
    this.refreshRows();
    if (selectedPath) {
      const next = this.rows.findIndex((row) => row.node.relativePath === selectedPath);
      if (next >= 0) this.selected = next;
    }
    if (this.file) {
      const filePath = this.file.relativePath;
      const row = flattenFileTree(this.root, new Set<string>([...this.expanded]), filePath, false)
        .find((candidate: TreeRow) => candidate.node.relativePath === filePath) as TreeRow | undefined;
      if (row) this.file = row.node;
    }
    this.renderedCache = undefined;
    this.notify("Zen Files refreshed.", "info");
  }

  private openFile(node: TreeNode): void {
    this.file = node;
    this.screen = "file";
    this.mode = "normal";
    this.scroll = 0;
    this.query = "";
    this.fileError = "";
    this.diffMode = Boolean(node.status && node.status !== "??" && this.snapshot.repoRoot);
    this.markdownMode = /\.md(?:own)?$/i.test(node.name) && !this.diffMode;
    try {
      this.raw = readTextFile(node.absolutePath, undefined, this.initialRoot);
      this.rawLines = this.raw.split("\n");
    } catch (error) {
      this.raw = "";
      this.rawLines = [];
      this.fileError = error instanceof Error ? error.message : String(error);
    }
    this.renderedCache = undefined;
  }

  private backToTree(): void {
    this.screen = "tree";
    this.mode = "normal";
    this.query = "";
    this.scroll = 0;
    this.file = undefined;
    this.comment = "";
    this.renderedCache = undefined;
  }

  private fileContent(width: number): string[] {
    const contentWidth = Math.max(1, width - 8);
    const kind = this.diffMode ? "diff" : this.markdownMode ? "markdown" : "source";
    if (this.renderedCache?.width === contentWidth && this.renderedCache.kind === kind) {
      return this.renderedCache.lines;
    }

    let lines: string[];
    if (this.diffMode && this.file) {
      const diff = readGitDiff(this.file.absolutePath, this.snapshot.repoRoot);
      lines = diff.length > 0 ? diff.map((line) => diffLine(line, this.theme)) : [this.theme.fg("dim", "No diff against HEAD.")];
    } else if (this.fileError) {
      lines = [this.theme.fg("error", sanitizeTerminalText(this.fileError))];
    } else if (this.markdownMode) {
      const markdown = new Markdown(sanitizeTerminalText(this.raw, { preserveNewlines: true }), 0, 0, getMarkdownTheme());
      lines = markdown.render(contentWidth);
    } else {
      const language = this.file ? getLanguageFromPath(this.file.absolutePath) : undefined;
      const safeSource = sanitizeTerminalText(this.raw, { preserveNewlines: true });
      const highlighted = highlightCode(safeSource, language, this.theme).split("\n");
      const digits = Math.max(3, String(Math.max(1, highlighted.length)).length);
      lines = highlighted.map((line, index) => {
        const number = this.theme.fg("dim", String(index + 1).padStart(digits));
        return `${number} ${this.theme.fg("borderMuted", "│")} ${line}`;
      });
    }
    this.renderedCache = { width: contentWidth, kind, lines };
    return lines;
  }

  private maxScroll(total: number): number {
    return Math.max(0, total - this.height);
  }

  private selectedRange(): [number, number] {
    return [
      Math.min(this.selectionAnchor, this.selectionCursor),
      Math.max(this.selectionAnchor, this.selectionCursor),
    ];
  }

  private submitComment(): void {
    if (!this.file || !this.comment.trim()) {
      this.mode = "normal";
      this.comment = "";
      return;
    }
    const [start, end] = this.selectedRange();
    const selectedText = this.rawLines.slice(start, end + 1).join("\n");
    const message = formatReviewMessage(this.file.relativePath, start + 1, end + 1, selectedText, this.comment);
    this.sendComment(message);
    this.mode = "normal";
    this.comment = "";
  }

  private renderTree(width: number): string[] {
    const lines = [borderLine("╭", "╮", "─ Z E N   F I L E S  ◆ ", width, this.theme, "borderAccent")];
    const changed = [...this.snapshot.statuses.values()].length;
    let subtitle = `${sanitizeTerminalText(compactHome(this.initialRoot))} · ${this.snapshot.files.length} files`;
    if (changed > 0) subtitle += ` · ${changed} changed`;
    if (this.snapshot.truncated) subtitle += " · partial";
    if (this.mode === "search") subtitle += ` · /${this.query}█`;
    if (this.changedOnly) subtitle += " · changed only";
    lines.push(framedRow(this.theme.fg("muted", subtitle), width, this.theme));
    lines.push(borderLine("├", "┤", "", width, this.theme));

    if (this.rows.length === 0) {
      lines.push(framedRow(this.theme.fg("dim", this.query ? "No matching files." : "No files found."), width, this.theme));
      for (let index = 1; index < this.height; index += 1) lines.push(framedRow("", width, this.theme));
    } else {
      const start = Math.max(0, Math.min(this.selected - Math.floor(this.height / 2), this.rows.length - this.height));
      const end = Math.min(this.rows.length, start + this.height);
      for (let index = start; index < end; index += 1) {
        const { node, depth } = this.rows[index];
        const open = node.directory && (this.expanded.has(node.relativePath) || Boolean(this.query));
        const marker = node.directory ? (open ? "◇" : "◆") : "·";
        const nameColor = node.directory ? (node.changed ? "warning" : "accent") : node.status ? "warning" : "text";
        const safeName = sanitizeTerminalText(node.name);
        const content = `${"  ".repeat(depth)}${this.theme.fg(node.directory ? "accent" : "dim", marker)} ${this.theme.fg(nameColor, safeName)}${statusLabel(node.status, this.theme)}`;
        lines.push(framedRow(content, width, this.theme, index === this.selected));
      }
      for (let index = end - start; index < this.height; index += 1) lines.push(framedRow("", width, this.theme));
    }

    lines.push(borderLine("├", "┤", "", width, this.theme));
    const help = this.mode === "search"
      ? "type to filter · ↑↓ move · enter accept · esc clear"
      : "j/k move · enter open · h/l fold · / search · c changed · r refresh · q close";
    lines.push(framedRow(this.theme.fg("dim", help), width, this.theme));
    lines.push(borderLine("╰", "╯", "─ quiet review, in place ", width, this.theme));
    return lines;
  }

  private renderFile(width: number): string[] {
    const content = this.fileContent(width);
    const lines = [borderLine("╭", "╮", "─ Z E N   V I E W  ◆ ", width, this.theme, "borderAccent")];
    let title = sanitizeTerminalText(this.file?.relativePath || "");
    if (this.diffMode) title += " · DIFF";
    else if (this.markdownMode) title += " · RENDERED";
    else title += " · SOURCE";
    if (this.mode === "select" || this.mode === "comment") {
      const [start, end] = this.selectedRange();
      title += ` · L${start + 1}${start === end ? "" : `–${end + 1}`}`;
    }
    lines.push(framedRow(this.theme.fg("muted", title), width, this.theme));
    lines.push(borderLine("├", "┤", "", width, this.theme));

    const start = Math.min(this.scroll, this.maxScroll(content.length));
    const [selectionStart, selectionEnd] = this.selectedRange();
    for (let offset = 0; offset < this.height; offset += 1) {
      const index = start + offset;
      const selected = !this.diffMode && !this.markdownMode && (this.mode === "select" || this.mode === "comment")
        && index >= selectionStart && index <= selectionEnd;
      lines.push(framedRow(content[index] || this.theme.fg("dim", "~"), width, this.theme, selected));
    }

    lines.push(borderLine("├", "┤", "", width, this.theme));
    if (this.mode === "comment") {
      const safeComment = sanitizeTerminalText(this.comment);
      lines.push(framedRow(`${this.theme.fg("accent", "Comment")} ${safeComment || this.theme.fg("dim", "type feedback")}█`, width, this.theme));
      lines.push(framedRow(this.theme.fg("dim", "ctrl+enter send · esc cancel"), width, this.theme));
    } else if (this.mode === "select") {
      lines.push(framedRow(this.theme.fg("dim", "j/k select lines · c comment · esc cancel"), width, this.theme));
    } else {
      const markdownHint = this.file && /\.md(?:own)?$/i.test(this.file.name) && !this.diffMode ? " · m raw/render" : "";
      const diffHint = this.file?.status && this.file.status !== "??" ? " · d diff/source" : "";
      lines.push(framedRow(this.theme.fg("dim", `j/k scroll · g/G ends · v select${markdownHint}${diffHint} · q back`), width, this.theme));
    }
    lines.push(borderLine("╰", "╯", "", width, this.theme));
    return lines;
  }

  render(width: number): string[] {
    this.renderWidth = width;
    return this.screen === "tree" ? this.renderTree(width) : this.renderFile(width);
  }

  invalidate(): void {
    this.renderedCache = undefined;
  }

  handleInput(data: string): void {
    if (this.screen === "tree") this.handleTreeInput(data);
    else this.handleFileInput(data);
    this.requestRender();
  }

  private handleTreeInput(data: string): void {
    if (this.mode === "search") {
      if (matchesKey(data, Key.escape)) {
        this.mode = "normal";
        this.query = "";
      } else if (matchesKey(data, Key.enter)) {
        this.mode = "normal";
      } else if (matchesKey(data, Key.backspace)) {
        this.query = this.query.slice(0, -1);
      } else if (matchesKey(data, Key.down) || matchesKey(data, "ctrl+n")) {
        this.selected = Math.min(this.rows.length - 1, this.selected + 1);
      } else if (matchesKey(data, Key.up) || matchesKey(data, "ctrl+p")) {
        this.selected = Math.max(0, this.selected - 1);
      } else {
        this.query += printableInput(data);
      }
      this.refreshRows();
      return;
    }

    if (matchesKey(data, "q") || matchesKey(data, Key.escape)) return this.close();
    if (matchesKey(data, "/")) {
      this.mode = "search";
      this.query = "";
      return;
    }
    if (matchesKey(data, "j") || matchesKey(data, Key.down)) this.selected = Math.min(this.rows.length - 1, this.selected + 1);
    else if (matchesKey(data, "k") || matchesKey(data, Key.up)) this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, Key.pageDown)) this.selected = Math.min(this.rows.length - 1, this.selected + this.height);
    else if (matchesKey(data, Key.pageUp)) this.selected = Math.max(0, this.selected - this.height);
    else if (matchesKey(data, "c")) {
      this.changedOnly = !this.changedOnly;
      this.selected = 0;
      this.refreshRows();
    } else if (matchesKey(data, "r")) this.reloadTree();
    else if (matchesKey(data, "+") || matchesKey(data, "=")) this.height = Math.min(MAX_HEIGHT, this.height + 2);
    else if (matchesKey(data, "-") || matchesKey(data, "_")) this.height = Math.max(MIN_HEIGHT, this.height - 2);
    else if (matchesKey(data, Key.enter) || matchesKey(data, "l") || matchesKey(data, Key.right)) {
      const node = this.rows[this.selected]?.node;
      if (!node) return;
      if (node.directory) {
        if (this.expanded.has(node.relativePath)) this.expanded.delete(node.relativePath);
        else this.expanded.add(node.relativePath);
        this.refreshRows();
      } else this.openFile(node);
    } else if (matchesKey(data, "h") || matchesKey(data, Key.left)) {
      const node = this.rows[this.selected]?.node;
      if (!node) return;
      if (node.directory && this.expanded.has(node.relativePath)) {
        this.expanded.delete(node.relativePath);
        this.refreshRows();
      } else if (node.parent?.relativePath) {
        const parentIndex = this.rows.findIndex((row) => row.node.relativePath === node.parent?.relativePath);
        if (parentIndex >= 0) this.selected = parentIndex;
      }
    }
  }

  private handleFileInput(data: string): void {
    if (this.mode === "comment") {
      if (matchesKey(data, "ctrl+enter") || matchesKey(data, "ctrl+d")) this.submitComment();
      else if (matchesKey(data, Key.escape)) {
        this.mode = "select";
        this.comment = "";
      } else if (matchesKey(data, Key.backspace)) this.comment = this.comment.slice(0, -1);
      else this.comment += printableInput(data);
      return;
    }

    if (this.mode === "select") {
      if (matchesKey(data, Key.escape)) this.mode = "normal";
      else if (matchesKey(data, "j") || matchesKey(data, Key.down)) {
        this.selectionCursor = Math.min(this.rawLines.length - 1, this.selectionCursor + 1);
        this.scroll = Math.min(this.selectionCursor, this.maxScroll(this.rawLines.length));
      } else if (matchesKey(data, "k") || matchesKey(data, Key.up)) {
        this.selectionCursor = Math.max(0, this.selectionCursor - 1);
        this.scroll = Math.min(this.scroll, this.selectionCursor);
      } else if (matchesKey(data, "c")) {
        this.mode = "comment";
        this.comment = "";
      }
      return;
    }

    const content = this.fileContent(this.renderWidth);
    if (matchesKey(data, "q") || matchesKey(data, Key.escape)) return this.backToTree();
    if (matchesKey(data, "j") || matchesKey(data, Key.down)) this.scroll = Math.min(this.maxScroll(content.length), this.scroll + 1);
    else if (matchesKey(data, "k") || matchesKey(data, Key.up)) this.scroll = Math.max(0, this.scroll - 1);
    else if (matchesKey(data, Key.pageDown)) this.scroll = Math.min(this.maxScroll(content.length), this.scroll + this.height);
    else if (matchesKey(data, Key.pageUp)) this.scroll = Math.max(0, this.scroll - this.height);
    else if (matchesKey(data, "g")) this.scroll = 0;
    else if (matchesKey(data, "shift+g") || data === "G") this.scroll = this.maxScroll(content.length);
    else if (matchesKey(data, "+") || matchesKey(data, "=")) this.height = Math.min(MAX_HEIGHT, this.height + 2);
    else if (matchesKey(data, "-") || matchesKey(data, "_")) this.height = Math.max(MIN_HEIGHT, this.height - 2);
    else if (matchesKey(data, "d") && this.file?.status && this.file.status !== "??") {
      this.diffMode = !this.diffMode;
      if (this.diffMode) this.markdownMode = false;
      this.scroll = 0;
      this.renderedCache = undefined;
    } else if (matchesKey(data, "m") && this.file && /\.md(?:own)?$/i.test(this.file.name) && !this.diffMode) {
      this.markdownMode = !this.markdownMode;
      this.scroll = 0;
      this.renderedCache = undefined;
    } else if (matchesKey(data, "v") && this.rawLines.length > 0) {
      if (this.diffMode || this.markdownMode) {
        this.diffMode = false;
        this.markdownMode = false;
        this.scroll = 0;
        this.renderedCache = undefined;
        this.notify("Source view enabled; press v again to select lines.", "info");
        return;
      }
      this.selectionAnchor = Math.min(this.scroll, this.rawLines.length - 1);
      this.selectionCursor = this.selectionAnchor;
      this.mode = "select";
    }
  }
}

export default function filesExtension(pi: ExtensionAPI): void {
  pi.registerCommand("files", {
    description: "Browse, read, diff, and comment on project files in the Tea House theme",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/files is available in interactive TUI mode.", "warning");
        return;
      }

      let root: string;
      try {
        root = resolveBrowserRoot(args, ctx.cwd);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }

      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        const component = new ZenFilesComponent(
          root,
          theme,
          () => tui.requestRender(),
          () => done(),
          (message, level) => ctx.ui.notify(message, level),
          (message) => {
            if (ctx.isIdle()) pi.sendUserMessage(message);
            else pi.sendUserMessage(message, { deliverAs: "followUp" });
            ctx.ui.notify("Review comment sent to the agent.", "success");
          },
        );
        return component;
      });
    },
  });
}
