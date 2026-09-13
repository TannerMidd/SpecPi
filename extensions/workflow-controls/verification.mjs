import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeRequiredChecks } from "./task-contract.mjs";

const source = fileURLToPath(new URL("../background-tasks/index.ts", import.meta.url));
const samePath = (left, right) =>
    process.platform === "win32"
        ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
        : path.resolve(left) === path.resolve(right);

function currentProvider(pi) {
    const tools = pi.getAllTools?.().filter((tool) => tool.name === "verify_run") ?? [];
    const actual = tools.length === 1 ? tools[0].sourceInfo?.path : undefined;

    return typeof actual === "string" && path.isAbsolute(actual) && samePath(actual, source);
}

export function currentReceipts(pi, root) {
    if (!currentProvider(pi)) {
        return [];
    }

    const replies = [];
    pi.events.emit("specpi:verification-receipts", {
        root,
        reply(value) {
            replies.push(value);
        },
    });
    if (!currentProvider(pi) || replies.length !== 1 || !Array.isArray(replies[0]) || replies[0].length > 32) {
        return [];
    }

    return replies[0];
}

export function selectRequiredChecks(selection, contract, receipts) {
    if (!Array.isArray(selection) || selection.length > 8) {
        throw new Error("Select at most eight required checks.");
    }

    const checks = selection.map((item) => {
        if (!item || Object.keys(item).some((key) => !["id", "label", "receiptId", "requirementIds"].includes(key))) {
            throw new Error("A check selection contains unsupported fields.");
        }

        const receipt = receipts.find(
            (candidate) =>
                candidate.id === item.receiptId &&
                candidate.root === contract.root &&
                ["passed", "failed", "stale"].includes(candidate.status),
        );
        if (!receipt) {
            throw new Error("Select a receipt from the current session and workspace.");
        }

        return {
            id: item.id,
            label: item.label,
            specDigest: receipt.specDigest,
            inputs: receipt.inputs,
            requirementIds: item.requirementIds,
        };
    });

    return normalizeRequiredChecks(checks, contract.requirements);
}

export function requiredCheckEvidence(contract, receipts) {
    return (contract?.requiredChecks ?? []).map((check) => {
        const matches = receipts.filter(
            (receipt) =>
                receipt.root === contract.root &&
                receipt.specDigest === check.specDigest &&
                JSON.stringify(receipt.inputs) === JSON.stringify(check.inputs),
        );
        // A later failed run is contradictory evidence; never hide it behind an older pass.
        const selected = matches.at(-1);

        return {
            checkId: check.id,
            label: check.label,
            requirementIds: [...check.requirementIds],
            receiptId: selected?.id,
            status: selected?.status ?? "unknown",
            reason: selected?.reason ?? "No matching live receipt; run the exact selected check again.",
        };
    });
}

export function renderCheckEvidence(evidence) {
    return [
        "### Required check evidence",
        ...evidence.map(
            (item) =>
                `- ${item.checkId}: ${item.status}${item.receiptId ? ` (receipt ${item.receiptId})` : ""} — ${item.reason}`,
        ),
        ...(evidence.length ? [] : ["- No runtime checks declared; requirement evidence remains a model assessment."]),
        "",
        "Receipt status is current only when collected. Saved summaries are historical; revalidation is required after changes or session restoration.",
    ].join("\n");
}
