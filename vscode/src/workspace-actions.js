"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { sensitivePath } = require("./context");
const { parseCodeReference, resolveCodeReference } = require("./code-references");

const FILE_EXCLUDES =
    "{**/.git/**,**/node_modules/**,**/.pi/**,**/.ssh/**,**/.gnupg/**,**/.aws/**,**/.azure/**,**/.kube/**}";
const latestSearch = new WeakMap();
const GROUPS = [
    ["workingTreeChanges", "Working tree"],
    ["indexChanges", "Staged"],
    ["untrackedChanges", "Untracked"],
    ["mergeChanges", "Merge conflict"],
];
const STATUS_LABELS = [
    "Modified",
    "Added",
    "Deleted",
    "Renamed",
    "Copied",
    "Modified",
    "Deleted",
    "Untracked",
    "Ignored",
    "Intent to add",
    "Intent to rename",
    "Type changed",
    "Added by us",
    "Added by them",
    "Deleted by us",
    "Deleted by them",
    "Both added",
    "Both deleted",
    "Both modified",
];

function within(root, candidate) {
    const relative = path.relative(root, candidate);

    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function capture(controller, vscode) {
    const workspacePath = controller.requireWorkspace();
    const workspace = controller.workspace;
    const generation = controller.generation;
    const sessionRevision = controller.sessionRevision;

    return {
        workspace,
        workspacePath,
        current() {
            if (
                controller.disposed ||
                (typeof controller.isForeground === "function" && !controller.isForeground()) ||
                !vscode.workspace.isTrusted ||
                controller.workspace !== workspace ||
                controller.generation !== generation ||
                controller.sessionRevision !== sessionRevision ||
                controller.workspaceSwitching ||
                controller.transitioning
            ) {
                return false;
            }

            try {
                return controller.requireWorkspace() === workspacePath;
            } catch {
                return false;
            }
        },
    };
}

function relativeFile(workspacePath, uri) {
    if (
        uri?.scheme !== "file" ||
        uri.authority ||
        uri.query ||
        uri.fragment ||
        typeof uri.fsPath !== "string" ||
        !path.isAbsolute(uri.fsPath) ||
        !within(workspacePath, uri.fsPath) ||
        sensitivePath(uri.fsPath)
    ) {
        return null;
    }

    const relative = path.relative(workspacePath, uri.fsPath).split(path.sep).join("/");
    const parsed = parseCodeReference(relative);
    if (
        !relative ||
        relative.includes(":") ||
        relative.split("/").some((part) => [".git", ".pi", "node_modules"].includes(part.toLowerCase())) ||
        !parsed ||
        parsed.path !== relative
    ) {
        return null;
    }

    return relative;
}

function suggestionPatterns(needle) {
    if (!needle) {
        return ["**/*"];
    }

    // VS Code globs escape metacharacters with single-character ranges, not
    // backslashes. Expand ASCII case explicitly for case-sensitive remote hosts.
    const literal = needle.replace(/[a-z\[\]{}*?,]/gu, (character) =>
        /[a-z]/u.test(character) ? `[${character}${character.toUpperCase()}]` : `[${character}]`,
    );

    // Keep filename and directory matches separate: VS Code's brace-alternation
    // parser does not preserve escaped literal braces inside a larger group.
    return [`**/*${literal}*`, `**/*${literal}*/**`];
}

async function findFiles(controller, vscode, query, requestId) {
    const context = capture(controller, vscode);
    const search = {};
    latestSearch.set(controller, search);
    try {
        await findWorkspaceFiles(controller, vscode, query, requestId, context, search);
    } catch (error) {
        if (context.current() && latestSearch.get(controller) === search) {
            throw error;
        }
    }
}

async function findWorkspaceFiles(controller, vscode, query, requestId, context, search) {
    if (!context.current()) {
        return;
    }

    if (typeof query !== "string" || query.length > 256) {
        controller.post({ type: "fileSuggestions", requestId, files: [] });

        return;
    }

    const needle = query.trim().replaceAll("\\", "/").toLowerCase();
    const uris = [];
    for (const pattern of suggestionPatterns(needle)) {
        // The combined cap applies to matching metadata hits, rather than the
        // first arbitrary files in the workspace. Contents stay unread here.
        const remaining = 500 - uris.length;
        const matches = await vscode.workspace.findFiles(
            new vscode.RelativePattern(context.workspace, pattern),
            FILE_EXCLUDES,
            remaining,
        );
        if (!context.current() || latestSearch.get(controller) !== search) {
            return;
        }

        uris.push(...matches.slice(0, remaining));
        if (uris.length >= 500) {
            break;
        }
    }

    // File discovery returns names only. The chosen attachment is validated and
    // read by the host's existing attachment collector after human selection.
    const names = new Set();
    for (const uri of uris.slice(0, 500)) {
        const relative = relativeFile(context.workspacePath, uri);
        if (relative && relative.toLowerCase().includes(needle)) {
            names.add(relative);
        }
    }

    const score = (name) => {
        const lower = name.toLowerCase();

        return lower.startsWith(needle) ? 0 : path.posix.basename(lower).startsWith(needle) ? 1 : 2;
    };

    const files = [...names]
        .sort((left, right) => score(left) - score(right) || left.localeCompare(right))
        .slice(0, 30)
        .map((name) => ({ path: name, label: name }));
    controller.post({ type: "fileSuggestions", requestId, files });
}

function changeIdentity(change) {
    return JSON.stringify([
        change.uri?.toString(),
        change.originalUri?.toString(),
        change.renameUri?.toString(),
        change.status,
    ]);
}

function changeItems(repositories, workspacePath) {
    const items = [];
    const seen = new Set();
    for (const repository of repositories) {
        for (const [group, description] of GROUPS) {
            for (const change of repository.state?.[group] || []) {
                const label = relativeFile(workspacePath, change.uri);
                const original = relativeFile(workspacePath, change.originalUri || change.uri);
                const renamed = change.renameUri ? relativeFile(workspacePath, change.renameUri) : label;
                if (!label || !original || !renamed || change.status === 8) {
                    continue;
                }

                const identity = changeIdentity(change);
                const key = `${repository.rootUri.toString()}:${group === "untrackedChanges" ? "workingTreeChanges" : group}:${identity}`;
                if (seen.has(key)) {
                    continue;
                }

                seen.add(key);
                items.push({
                    label,
                    description: `${description} · ${STATUS_LABELS[change.status] || "Changed"}`,
                    ...(original === label ? {} : { detail: `From ${original}` }),
                    repository,
                    group,
                    change,
                    identity,
                });
            }
        }
    }

    return items.sort((left, right) => left.label.localeCompare(right.label) || left.group.localeCompare(right.group));
}

async function validateFile(workspacePath, uri, allowMissing) {
    if (!relativeFile(workspacePath, uri)) {
        throw new Error("This change is outside the selected workspace or references a private file.");
    }

    try {
        await fs.lstat(uri.fsPath);
    } catch (error) {
        if (!allowMissing || error.code !== "ENOENT") {
            throw new Error("The changed workspace file is unavailable.");
        }

        // Deleted and renamed source paths have no current file. Validate their
        // nearest existing ancestor before allowing the Git API's historical URI.
        const root = await fs.realpath(workspacePath);
        let ancestor = path.dirname(uri.fsPath);
        while (within(workspacePath, ancestor)) {
            try {
                const info = await fs.lstat(ancestor);
                const canonical = await fs.realpath(ancestor);
                if (!info.isDirectory() || !within(root, canonical) || sensitivePath(canonical)) {
                    throw new Error("The changed file's parent cannot be opened safely from chat.");
                }

                return;
            } catch (ancestorError) {
                if (ancestorError.code !== "ENOENT") {
                    throw ancestorError;
                }
            }

            ancestor = path.dirname(ancestor);
        }

        throw new Error("The changed file's parent is outside the selected workspace.");
    }

    await resolveCodeReference({ workspacePath, reference: uri.fsPath });
}

async function sourceControlFallback(vscode, context, message) {
    if (!context.current()) {
        return;
    }

    // Do not await dismissal of a notification before opening the requested view.
    void vscode.window.showInformationMessage(message);
    await vscode.commands.executeCommand("workbench.view.scm");
}

async function reviewChanges(controller, vscode) {
    const context = capture(controller, vscode);
    try {
        await reviewWorkspaceChanges(context, vscode);
    } catch (error) {
        if (context.current()) {
            throw error;
        }
    }
}

async function reviewWorkspaceChanges(context, vscode) {
    if (!context.current()) {
        return;
    }

    let api;
    try {
        const extension = vscode.extensions.getExtension("vscode.git");
        const exported = extension?.isActive ? extension.exports : await extension?.activate();
        if (exported?.enabled !== false) {
            api = exported?.getAPI(1);
        }
    } catch {
        // Disabled or unavailable built-in Git still has a useful native fallback.
    }

    if (!context.current()) {
        return;
    }

    if (!api || typeof api.toGitUri !== "function") {
        return sourceControlFallback(vscode, context, "Git review is unavailable. Opening Source Control.");
    }

    const primary = api.getRepository?.(context.workspace.uri);
    const candidates = [...(primary ? [primary] : []), ...(api.repositories || [])];
    const roots = new Set();
    const repositories = candidates.filter((repository) => {
        const root = repository.rootUri;
        if (
            root?.scheme !== "file" ||
            root.authority ||
            root.query ||
            root.fragment ||
            typeof root.fsPath !== "string" ||
            !path.isAbsolute(root.fsPath) ||
            sensitivePath(root.fsPath) ||
            /(?:^|[/\\])(?:\.git|\.pi|node_modules)(?:[/\\]|$)/iu.test(root.fsPath) ||
            (!within(root.fsPath, context.workspacePath) && !within(context.workspacePath, root.fsPath)) ||
            roots.has(root.toString())
        ) {
            return false;
        }

        roots.add(root.toString());

        return true;
    });
    if (!repositories.length) {
        return sourceControlFallback(
            vscode,
            context,
            "No Git repository is available for the selected workspace. Opening Source Control.",
        );
    }

    const canonicalWorkspace = await fs.realpath(context.workspacePath);
    if (!context.current()) {
        return;
    }

    if (
        sensitivePath(canonicalWorkspace) ||
        /(?:^|[/\\])(?:\.git|\.pi|node_modules)(?:[/\\]|$)/iu.test(canonicalWorkspace)
    ) {
        throw new Error("Private state folders cannot be reviewed from chat.");
    }

    const availableRepositories = [];
    for (const repository of repositories) {
        let canonicalRoot;
        try {
            canonicalRoot = await fs.realpath(repository.rootUri.fsPath);
        } catch {
            continue;
        }

        if (
            sensitivePath(canonicalRoot) ||
            /(?:^|[/\\])(?:\.git|\.pi|node_modules)(?:[/\\]|$)/iu.test(canonicalRoot) ||
            (!within(canonicalRoot, canonicalWorkspace) && !within(canonicalWorkspace, canonicalRoot))
        ) {
            continue;
        }

        if (!context.current()) {
            return;
        }

        await repository.status();
        if (!context.current()) {
            return;
        }

        availableRepositories.push(repository);
    }

    if (!context.current()) {
        return;
    }

    const items = changeItems(availableRepositories, context.workspacePath);
    if (!items.length) {
        void vscode.window.showInformationMessage("No reviewable changes in the selected workspace.");

        return;
    }

    const selected = await vscode.window.showQuickPick(items, {
        title: "Workspace changes",
        placeHolder: "Review all workspace changes, including edits made before this chat",
        matchOnDescription: true,
        matchOnDetail: true,
    });
    if (!selected || !items.includes(selected) || !context.current()) {
        return;
    }

    const { repository, group, change, identity } = selected;
    const stillChanged = () =>
        (api.repositories || []).some((candidate) => candidate.rootUri.toString() === repository.rootUri.toString()) &&
        (repository.state?.[group] || []).some((current) => changeIdentity(current) === identity);
    if (!stillChanged()) {
        throw new Error("This change was updated while the picker was open. Review workspace changes again.");
    }

    const staged = group === "indexChanges";
    const deleted = change.status === 2 || change.status === 6;
    const conflict = group === "mergeChanges";
    await validateFile(context.workspacePath, change.uri, staged || deleted || conflict);
    if (change.originalUri && change.originalUri.toString() !== change.uri.toString()) {
        await validateFile(context.workspacePath, change.originalUri, true);
    }

    if (change.renameUri && change.renameUri.toString() !== change.uri.toString()) {
        await validateFile(context.workspacePath, change.renameUri, staged || deleted || conflict);
    }

    if (!context.current()) {
        return;
    }

    if (!stillChanged()) {
        throw new Error("This change was updated while the picker was open. Review workspace changes again.");
    }

    const title = `Workspace changes · ${selected.label} (${selected.description})`;
    const options = { preview: false };
    if (conflict) {
        await vscode.commands.executeCommand("git.openChange", change.uri);
    } else if (deleted) {
        await vscode.commands.executeCommand(
            "vscode.open",
            api.toGitUri(change.originalUri || change.uri, staged ? "HEAD" : "~"),
            options,
            title,
        );
    } else if (change.status === 1 || change.status === 7 || change.status === 9) {
        await vscode.commands.executeCommand(
            "vscode.open",
            staged ? api.toGitUri(change.uri, "") : change.uri,
            options,
            title,
        );
    } else {
        // Git's public API creates these document URIs. Empty ref means the
        // index; '~' selects the index when staged changes exist, otherwise HEAD.
        // A staged diff must never use the working file as its right side.
        const original = staged || change.status === 10 ? change.originalUri || change.uri : change.uri;
        const left = api.toGitUri(original, staged || change.status === 10 ? "HEAD" : "~");
        const right = staged ? api.toGitUri(change.uri, "") : change.uri;
        await vscode.commands.executeCommand("vscode.diff", left, right, title, options);
    }
}

module.exports = { findFiles, reviewChanges };
