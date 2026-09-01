import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parsePorcelainEntries, parsePorcelainZ, sanitizePathLabel } from "./scope.mjs";

const REGISTRY_SCHEMA = 1;
const MAX_EXPERIMENTS = 32;
const MAX_TEXT = 600;
const MAX_IGNORED_PATHS = 200;
const MAX_PATCH_BYTES = 32_000_000;

function compact(value, maximum = MAX_TEXT) {
    return String(value ?? "")
        .normalize("NFKC")
        .replace(/[\u0000-\u001f\u007f]+/gu, " ")
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, maximum);
}

function experimentStateRoot(stateDir) {
    return path.join(path.resolve(stateDir), "experiments");
}

function registryPath(stateDir) {
    return path.join(experimentStateRoot(stateDir), "registry.json");
}

function lockPath(stateDir) {
    return path.join(experimentStateRoot(stateDir), "registry.lock");
}

function ensurePrivateDirectory(directory) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("Private experiment state directory must not be a symbolic link");
    }

    try {
        fs.chmodSync(directory, 0o700);
    } catch {
        /* Windows permissions are inherited from the profile. */
    }
}

function prepareDestination(file, privateParent) {
    const parent = path.dirname(file);
    if (privateParent) {
        ensurePrivateDirectory(parent);
        if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) {
            throw new Error("Private experiment state file must not be a symbolic link");
        }
    } else {
        const stat = fs.statSync(parent);
        if (!stat.isDirectory()) {
            throw new Error("Patch output parent must be an existing directory");
        }

        if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) {
            throw new Error("Refusing to replace a symbolic-link patch output");
        }
    }

    return parent;
}

function applyMode(file, mode) {
    try {
        fs.chmodSync(file, mode);
    } catch {
        /* Windows permissions are inherited from the profile. */
    }
}

function atomicWrite(file, bytes, mode = 0o600, privateParent = true) {
    const parent = prepareDestination(file, privateParent);
    const temporary = path.join(parent, `.${path.basename(file)}.${randomUUID()}.tmp`);
    fs.writeFileSync(temporary, bytes, { mode, flag: "wx" });
    fs.renameSync(temporary, file);
    applyMode(file, mode);
}

// Patch bytes are never decoded into a JavaScript string: a text file that is not valid UTF-8 would lose its original
// bytes on the way back out and produce a patch that no longer applies. Git writes the file itself and we only move it.
function atomicAdopt(source, file, { mode = 0o600, privateParent = true, overwrite = false } = {}) {
    prepareDestination(file, privateParent);
    applyMode(source, mode);
    // Without approval to overwrite, the destination has to be claimed exclusively rather than checked and then
    // replaced: `rename` silently clobbers whatever appeared in the gap, while `link` fails closed with EEXIST.
    if (!overwrite) {
        try {
            fs.linkSync(source, file);
            fs.rmSync(source, { force: true });
            applyMode(file, mode);

            return;
        } catch (error) {
            if (error?.code === "EEXIST") {
                throw new Error("Patch output appeared before it could be written; explicit overwrite is required");
            }

            if (error?.code !== "EXDEV" && error?.code !== "EPERM" && error?.code !== "ENOSYS") {
                throw error;
            }
        }

        // Hard links are unavailable across volumes and on some filesystems; COPYFILE_EXCL keeps the same guarantee.
        fs.copyFileSync(source, file, fs.constants.COPYFILE_EXCL);
        fs.rmSync(source, { force: true });
        applyMode(file, mode);

        return;
    }

    try {
        fs.renameSync(source, file);
    } catch (error) {
        if (error?.code !== "EXDEV") {
            throw error;
        }

        const parent = path.dirname(file);
        const temporary = path.join(parent, `.${path.basename(file)}.${randomUUID()}.tmp`);
        fs.copyFileSync(source, temporary);
        applyMode(temporary, mode);
        fs.renameSync(temporary, file);
        fs.rmSync(source, { force: true });
    }

    applyMode(file, mode);
}

function validCommit(value) {
    return typeof value === "string" && /^[0-9a-f]{40,64}$/u.test(value);
}

function validateRecord(record) {
    if (
        !record ||
        typeof record !== "object" ||
        typeof record.id !== "string" ||
        !/^[0-9a-f-]{36}$/u.test(record.id) ||
        typeof record.name !== "string" ||
        !["prepared", "active", "closing"].includes(record.status) ||
        typeof record.repoRoot !== "string" ||
        !path.isAbsolute(record.repoRoot) ||
        typeof record.commonDir !== "string" ||
        !path.isAbsolute(record.commonDir) ||
        typeof record.worktreePath !== "string" ||
        !path.isAbsolute(record.worktreePath) ||
        !validCommit(record.baseCommit) ||
        typeof record.hypothesis !== "string" ||
        typeof record.acceptance !== "string" ||
        !Array.isArray(record.nonGoals) ||
        record.nonGoals.some((item) => typeof item !== "string") ||
        typeof record.createdAt !== "string" ||
        !Number.isFinite(Date.parse(record.createdAt)) ||
        typeof record.updatedAt !== "string" ||
        !Number.isFinite(Date.parse(record.updatedAt))
    ) {
        throw new Error(`Malformed experiment registry record: ${record?.id ?? "unknown"}`);
    }

    return record;
}

export function validateExperimentRegistry(value) {
    if (!value || value.schema !== REGISTRY_SCHEMA || !Array.isArray(value.experiments)) {
        throw new Error("Experiment registry schema is invalid");
    }

    if (value.experiments.length > MAX_EXPERIMENTS) {
        throw new Error(`Experiment registry exceeds ${MAX_EXPERIMENTS} entries`);
    }

    const ids = new Set();
    const worktrees = new Set();
    for (const record of value.experiments) {
        validateRecord(record);
        const worktree = process.platform === "win32" ? record.worktreePath.toLowerCase() : record.worktreePath;
        if (ids.has(record.id) || worktrees.has(worktree)) {
            throw new Error("Experiment registry contains duplicate identities");
        }

        ids.add(record.id);
        worktrees.add(worktree);
    }

    return value;
}

export function readExperimentRegistry(stateDir) {
    const file = registryPath(stateDir);
    if (!fs.existsSync(file)) {
        return { schema: REGISTRY_SCHEMA, experiments: [] };
    }

    return validateExperimentRegistry(JSON.parse(fs.readFileSync(file, "utf8")));
}

async function withRegistryLock(stateDir, operation) {
    const root = experimentStateRoot(stateDir);
    ensurePrivateDirectory(root);
    const lock = lockPath(stateDir);
    const owner = { pid: process.pid, token: randomUUID(), createdAt: new Date().toISOString() };
    try {
        fs.mkdirSync(lock, { mode: 0o700 });
        fs.writeFileSync(path.join(lock, "owner.json"), `${JSON.stringify(owner)}\n`, { mode: 0o600, flag: "wx" });
    } catch (error) {
        if (error?.code === "EEXIST") {
            throw new Error("Experiment registry is locked; inspect the owner before manual recovery");
        }

        throw error;
    }

    try {
        return await operation();
    } finally {
        let current;
        try {
            current = JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8"));
        } catch {
            current = undefined;
        }

        if (current?.token === owner.token) {
            fs.rmSync(lock, { recursive: true, force: true });
        }
    }
}

async function updateRegistry(stateDir, mutate) {
    return withRegistryLock(stateDir, async () => {
        const registry = readExperimentRegistry(stateDir);
        const result = await mutate(registry);
        validateExperimentRegistry(registry);
        atomicWrite(registryPath(stateDir), `${JSON.stringify(registry, null, 2)}\n`);

        return result;
    });
}

async function git(exec, cwd, args, options = {}) {
    const result = await exec("git", args, { cwd, timeout: options.timeout ?? 30_000, env: options.env });
    if (!result || result.code !== 0) {
        const detail = compact(result?.stderr || result?.stdout || "Git command failed", 300);
        throw new Error(detail || "Git command failed");
    }

    if (
        typeof result.stdout !== "string" ||
        Buffer.byteLength(result.stdout, "utf8") > (options.maxBytes ?? 16_000_000)
    ) {
        throw new Error("Git output is missing or exceeds the safety bound");
    }

    return result.stdout;
}

export async function inspectRepository(exec, cwd) {
    const rootOutput = await git(exec, cwd, ["rev-parse", "--show-toplevel"]);
    const repoRoot = fs.realpathSync.native(path.resolve(cwd, rootOutput.trim()));
    const commonOutput = await git(exec, repoRoot, ["rev-parse", "--git-common-dir"]);
    const commonCandidate = path.resolve(repoRoot, commonOutput.trim());
    const commonDir = fs.realpathSync.native(commonCandidate);
    const baseCommit = (await git(exec, repoRoot, ["rev-parse", "HEAD"])).trim();
    if (!validCommit(baseCommit)) {
        throw new Error("Git returned an invalid HEAD commit");
    }

    const statusOutput = await git(exec, repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const changedPaths = parsePorcelainZ(statusOutput);

    return { repoRoot, commonDir, baseCommit, changedPaths };
}

export function sanitizeExperimentCard(card) {
    const name = compact(card?.name, 48)
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/gu, "-")
        .replace(/^-+|-+$/gu, "");
    const hypothesis = compact(card?.hypothesis);
    const acceptance = compact(card?.acceptance);
    const nonGoals = Array.isArray(card?.nonGoals)
        ? card.nonGoals
              .map((item) => compact(item, 240))
              .filter(Boolean)
              .slice(0, 8)
        : [];
    if (!name || !hypothesis || !acceptance) {
        throw new Error("Experiment name, hypothesis, and acceptance check are required");
    }

    return { name, hypothesis, acceptance, nonGoals };
}

export async function createExperiment({ exec, stateDir, repository, card, now = new Date().toISOString() }) {
    const sanitized = sanitizeExperimentCard(card);
    const id = randomUUID();
    const root = experimentStateRoot(stateDir);
    const worktreesRoot = path.join(root, "worktrees");
    ensurePrivateDirectory(worktreesRoot);
    const worktreePath = path.join(worktreesRoot, `${sanitized.name}-${id.slice(0, 8)}`);
    const record = {
        id,
        ...sanitized,
        status: "prepared",
        repoRoot: repository.repoRoot,
        commonDir: repository.commonDir,
        worktreePath,
        baseCommit: repository.baseCommit,
        createdAt: now,
        updatedAt: now,
    };

    await updateRegistry(stateDir, (registry) => {
        if (registry.experiments.length >= MAX_EXPERIMENTS) {
            throw new Error(`At most ${MAX_EXPERIMENTS} experiments may be retained`);
        }

        registry.experiments.push(record);
    });

    try {
        await git(exec, repository.repoRoot, ["worktree", "add", "--detach", worktreePath, repository.baseCommit], {
            timeout: 120_000,
        });
        const canonicalWorktree = fs.realpathSync.native(worktreePath);
        await updateRegistry(stateDir, (registry) => {
            const current = registry.experiments.find((item) => item.id === id);
            if (!current || current.status !== "prepared") {
                throw new Error("Experiment transaction changed during worktree creation");
            }

            current.worktreePath = canonicalWorktree;
            current.status = "active";
            current.updatedAt = new Date().toISOString();
        });

        return readExperimentRegistry(stateDir).experiments.find((item) => item.id === id);
    } catch (error) {
        throw new Error(`Experiment ${id.slice(0, 8)} remains prepared for /experiment recover: ${error.message}`);
    }
}

export function findExperiment(stateDir, query, cwd) {
    const records = readExperimentRegistry(stateDir).experiments;
    const needle = compact(query, 64).toLowerCase();
    let matches;
    if (needle) {
        matches = records.filter(
            (record) => record.id.toLowerCase().startsWith(needle) || record.name.toLowerCase() === needle,
        );
    } else if (cwd) {
        let canonical;
        try {
            canonical = fs.realpathSync.native(path.resolve(cwd));
        } catch {
            canonical = path.resolve(cwd);
        }

        const comparable = process.platform === "win32" ? canonical.toLowerCase() : canonical;
        matches = records.filter((record) => {
            const candidate = process.platform === "win32" ? record.worktreePath.toLowerCase() : record.worktreePath;

            return candidate === comparable;
        });
    } else {
        matches = records;
    }

    if (matches.length !== 1) {
        throw new Error(matches.length === 0 ? "No matching experiment" : "Experiment ID is ambiguous");
    }

    return matches[0];
}

export async function experimentStatus(exec, record) {
    // Committing inside an experiment moves its HEAD, and everything measured against HEAD then reports clean. The
    // recorded base commit is the only fixed point, so committed work stays visible to status, export, and discard.
    let headCommit;
    let committedPaths = [];
    let committedUnknown = false;
    try {
        headCommit = (await git(exec, record.worktreePath, ["rev-parse", "HEAD"])).trim();
        if (headCommit !== record.baseCommit) {
            const names = await git(exec, record.worktreePath, [
                "diff",
                "--name-only",
                "-z",
                record.baseCommit,
                "HEAD",
            ]);
            committedPaths = [...new Set(names.split("\0").filter(Boolean).map(sanitizePathLabel))].sort();
        }
    } catch {
        // A missing or unreachable base object must not block closing the experiment; assume work may exist.
        committedUnknown = true;
    }

    // Ignored files are invisible to both a plain `status` and `git add -A`, so a worktree holding only ignored work
    // looks clean, exports to an empty patch, and would be destroyed by discard without a second confirmation.
    const output = await git(exec, record.worktreePath, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignored=matching",
    ]);
    const entries = parsePorcelainEntries(output);
    const changedPaths = [
        ...new Set(entries.filter((entry) => entry.status !== "!!").map((entry) => entry.path)),
    ].sort();
    const untracked = entries.filter((entry) => entry.status === "??").length;
    const ignoredPaths = [...new Set(entries.filter((entry) => entry.status === "!!").map((entry) => entry.path))]
        .sort()
        .slice(0, MAX_IGNORED_PATHS);

    return {
        ...record,
        changedPaths,
        untracked,
        ignoredPaths,
        ignored: ignoredPaths.length,
        headCommit,
        committedPaths,
        committed: committedPaths.length,
        committedUnknown,
        // Anything that would be destroyed by a discard, whether or not a patch could carry it.
        hasWork: changedPaths.length > 0 || ignoredPaths.length > 0 || committedPaths.length > 0 || committedUnknown,
    };
}

export async function exportExperimentPatch({ exec, stateDir, record, outputPath, overwrite = false }) {
    const root = experimentStateRoot(stateDir);
    ensurePrivateDirectory(path.join(root, "exports"));
    const destination = path.resolve(
        outputPath || path.join(root, "exports", `${record.name}-${record.id.slice(0, 8)}.patch`),
    );
    if (fs.existsSync(destination) && !overwrite) {
        throw new Error("Patch output already exists; explicit overwrite approval is required");
    }

    ensurePrivateDirectory(path.join(root, "tmp"));
    const temporaryIndex = path.join(root, "tmp", `${record.id}-${randomUUID()}.index`);
    const temporaryPatch = path.join(root, "tmp", `${record.id}-${randomUUID()}.patch`);
    const environment = { ...process.env, GIT_INDEX_FILE: temporaryIndex };
    try {
        // Seeding the temporary index from the base commit and staging the working tree makes the diff cover every
        // change since the experiment started, whether the human committed it or left it dirty.
        await git(exec, record.worktreePath, ["read-tree", record.baseCommit], { env: environment });
        await git(exec, record.worktreePath, ["add", "-A"], { env: environment, timeout: 120_000 });
        await git(
            exec,
            record.worktreePath,
            ["diff", "--cached", "--binary", `--output=${temporaryPatch}`, record.baseCommit],
            { env: environment, timeout: 120_000 },
        );
        const bytes = fs.statSync(temporaryPatch).size;
        if (bytes > MAX_PATCH_BYTES) {
            throw new Error(`Exported patch exceeds the ${MAX_PATCH_BYTES}-byte safety bound`);
        }

        atomicAdopt(temporaryPatch, destination, { mode: 0o600, privateParent: false, overwrite });

        return { outputPath: destination, bytes };
    } finally {
        fs.rmSync(temporaryIndex, { force: true });
        fs.rmSync(`${temporaryIndex}.lock`, { force: true });
        fs.rmSync(temporaryPatch, { force: true });
    }
}

async function verifyWorktreeIdentity(exec, record) {
    const canonical = fs.realpathSync.native(record.worktreePath);
    if (canonical !== record.worktreePath) {
        throw new Error("Registered worktree path identity changed");
    }

    const commonOutput = await git(exec, canonical, ["rev-parse", "--git-common-dir"]);
    const commonDir = fs.realpathSync.native(path.resolve(canonical, commonOutput.trim()));
    if (commonDir !== record.commonDir) {
        throw new Error("Registered worktree belongs to a different repository");
    }
}

export async function discardExperiment({ exec, stateDir, record }) {
    await verifyWorktreeIdentity(exec, record);
    await updateRegistry(stateDir, (registry) => {
        const current = registry.experiments.find((item) => item.id === record.id);
        if (!current || current.status !== "active" || current.worktreePath !== record.worktreePath) {
            throw new Error("Experiment changed before discard");
        }

        current.status = "closing";
        current.updatedAt = new Date().toISOString();
    });

    await verifyWorktreeIdentity(exec, record);
    await git(exec, record.repoRoot, ["worktree", "remove", "--force", record.worktreePath], { timeout: 120_000 });
    await updateRegistry(stateDir, (registry) => {
        registry.experiments = registry.experiments.filter((item) => item.id !== record.id);
    });
}

export function parseWorktreeList(output) {
    if (typeof output !== "string") {
        throw new Error("Git worktree list is unavailable");
    }

    const records = [];
    for (const block of output.trim().split(/\n\n+/u)) {
        if (!block.trim()) {
            continue;
        }

        const fields = Object.fromEntries(
            block.split("\n").map((line) => {
                const separator = line.indexOf(" ");

                return separator < 0 ? [line, true] : [line.slice(0, separator), line.slice(separator + 1)];
            }),
        );
        if (typeof fields.worktree !== "string") {
            throw new Error("Malformed Git worktree list");
        }

        records.push(fields);
    }

    return records;
}

function comparablePath(value) {
    return process.platform === "win32" ? value.toLowerCase() : value;
}

async function registeredWorktreePaths(exec, repoRoot) {
    const listed = parseWorktreeList(await git(exec, repoRoot, ["worktree", "list", "--porcelain"]));

    return new Set(listed.map((record) => comparablePath(path.resolve(record.worktree))));
}

export async function recoverExperiments({ exec, stateDir, repoRoot }) {
    const paths = await registeredWorktreePaths(exec, repoRoot);
    const known = readExperimentRegistry(stateDir).experiments.filter((record) => record.repoRoot === repoRoot);

    return known.map((record) => {
        const present = paths.has(comparablePath(record.worktreePath));

        return {
            record,
            present,
            // A directory that Git no longer tracks as a worktree is an orphan left by an interrupted creation. It can
            // never be activated, so recovery has to offer releasing the record while leaving the files for the human.
            orphanDirectory: !present && fs.existsSync(record.worktreePath),
            needsRecovery: record.status !== "active" || !present,
        };
    });
}

export async function repairExperimentRecord(stateDir, id, action, { exec, repoRoot } = {}) {
    if (typeof exec !== "function" || typeof repoRoot !== "string" || !path.isAbsolute(repoRoot)) {
        throw new Error("Experiment recovery requires repository access");
    }

    return updateRegistry(stateDir, async (registry) => {
        const record = registry.experiments.find((item) => item.id === id);
        if (!record) {
            throw new Error("Experiment record no longer exists");
        }

        if (record.repoRoot !== repoRoot) {
            throw new Error("Experiment record belongs to a different repository");
        }

        // The choice that selected this action was made before an interactive prompt, and an external `git worktree`
        // command during that prompt would invalidate it. Presence is re-derived here, inside the registry lock and
        // immediately before the mutation, so a stale answer cannot drop a live record or adopt a replaced directory.
        const present = (await registeredWorktreePaths(exec, repoRoot)).has(comparablePath(record.worktreePath));
        const exists = fs.existsSync(record.worktreePath);

        if (action === "activate") {
            if (!present || !exists) {
                throw new Error("Worktree is no longer registered with Git; run /experiment recover again");
            }

            const canonical = fs.realpathSync.native(record.worktreePath);
            const commonOutput = await git(exec, canonical, ["rev-parse", "--git-common-dir"]);
            if (fs.realpathSync.native(path.resolve(canonical, commonOutput.trim())) !== record.commonDir) {
                throw new Error("Registered worktree belongs to a different repository");
            }

            record.worktreePath = canonical;
            record.status = "active";
            record.updatedAt = new Date().toISOString();

            return {};
        }

        if (action === "forget" || action === "release") {
            if (present) {
                throw new Error("Refusing to drop a record Git still tracks as a worktree");
            }

            if (action === "forget" && exists) {
                throw new Error("Refusing to forget an existing directory; release the record instead");
            }

            if (action === "release" && !exists) {
                throw new Error("Nothing to release; forget the record instead");
            }

            registry.experiments = registry.experiments.filter((item) => item.id !== id);

            return { released: action === "release" ? record.worktreePath : undefined };
        }

        throw new Error("Unsupported recovery action");
    });
}

export function defaultPatchPath(stateDir, record) {
    return path.join(experimentStateRoot(stateDir), "exports", `${record.name}-${record.id.slice(0, 8)}.patch`);
}
