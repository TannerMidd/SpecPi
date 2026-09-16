/** Runs a command and resolves its result; supplied by the caller so this module never spawns directly. */
export type Exec = (
    command: string,
    args: string[],
    options?: Record<string, unknown>,
) => Promise<{ code: number; stdout: string; stderr: string }>;

export type ExperimentCard = {
    name: string;
    hypothesis: string;
    acceptance: string;
    nonGoals: string[];
};

export type ExperimentStatusName = "prepared" | "active" | "released";

export type ExperimentRecord = ExperimentCard & {
    id: string;
    status: ExperimentStatusName;
    repoRoot: string;
    commonDir: string;
    worktreePath: string;
    baseCommit: string;
    createdAt: string;
    updatedAt: string;
};

export type RepositoryInfo = {
    repoRoot: string;
    commonDir: string;
    baseCommit: string;
    changedPaths: string[];
};

export type ExperimentStatus = ExperimentRecord & {
    changedPaths: string[];
    untracked: number;
    ignoredPaths: string[];
    ignored: number;
    headCommit: string;
    committedPaths: string[];
    committed: number;
    committedUnknown: boolean;
    /** Anything a discard would destroy, whether or not a patch could carry it. */
    hasWork: boolean;
};

export type RecoveryFinding = {
    record: ExperimentRecord;
    present: boolean;
    orphanDirectory: boolean;
    needsRecovery: boolean;
};

export type ExperimentRegistry = { schema: number; experiments: ExperimentRecord[] };

export type WorktreeEntry = { worktree: string; HEAD?: string; detached?: boolean; branch?: string };

export function validateExperimentRegistry(value: unknown): ExperimentRegistry;
export function readExperimentRegistry(stateDir: string): ExperimentRegistry;
export function inspectRepository(exec: Exec, cwd: string): Promise<RepositoryInfo>;
export function sanitizeExperimentCard(card: Partial<ExperimentCard>): ExperimentCard;
export function createExperiment(options: {
    exec: Exec;
    stateDir: string;
    repository: RepositoryInfo;
    card: Partial<ExperimentCard>;
    now?: string;
}): Promise<ExperimentRecord>;
export function findExperiment(stateDir: string, query: string, cwd: string): ExperimentRecord;
export function experimentStatus(exec: Exec, record: ExperimentRecord): Promise<ExperimentStatus>;
export function exportExperimentPatch(options: {
    exec: Exec;
    stateDir: string;
    record: ExperimentRecord;
    outputPath: string;
    overwrite?: boolean;
}): Promise<{ outputPath: string; bytes: number }>;
export function discardExperiment(options: { exec: Exec; stateDir: string; record: ExperimentRecord }): Promise<void>;
export function parseWorktreeList(output: string): WorktreeEntry[];
export function recoverExperiments(options: {
    exec: Exec;
    stateDir: string;
    repoRoot: string;
}): Promise<RecoveryFinding[]>;
export function repairExperimentRecord(
    stateDir: string,
    id: string,
    action: "activate" | "forget" | "release",
    access?: { exec?: Exec; repoRoot?: string },
): Promise<{ released?: string } | undefined>;
export function defaultPatchPath(stateDir: string, record: ExperimentRecord): string;
