export const CYCLE_STAGES = Object.freeze(
    [
        { stage: "friction", status: "open" },
        { stage: "repeat", status: "qualified" },
        { stage: "choose", status: "selected" },
        { stage: "build", status: "selected" },
        { stage: "prove", status: "verifying" },
        { stage: "retire", status: "retired" },
        { stage: "return", status: "review-needed" },
    ].map((stage) => Object.freeze(stage)),
);

export function nextCycleStep(current) {
    return current >= CYCLE_STAGES.length - 1 ? 2 : current + 1;
}

export function previousCycleStep(current) {
    return Math.max(0, current - 1);
}

export const GUARD_MODES = Object.freeze({
    guard: {
        description:
            "Confirmed host-wide destruction and enforcement tampering are denied. Destructive Git operations and unresolved commands ask first. Determinate, non-catastrophic work runs.",
        verdicts: [
            ["denied · never approvable", "deny"],
            ["asks first", "ask"],
            ["runs", "pass"],
            ["asks first", "ask"],
            ["runs quietly", "pass"],
        ],
    },
    strict: {
        description:
            "Host-wide destructive commands remain denied. Mutation, execution, sensitive reads, and network activity require approval.",
        verdicts: [
            ["denied · never approvable", "deny"],
            ["asks first", "ask"],
            ["asks first", "ask"],
            ["asks first", "ask"],
            ["asks first", "ask"],
        ],
    },
    off: {
        description:
            "Protection is disabled for the current session after two confirmations. A later session does not inherit this mode.",
        verdicts: [
            ["runs · unprotected", "deny"],
            ["runs · unprotected", "off"],
            ["runs · unprotected", "off"],
            ["runs · unprotected", "off"],
            ["runs", "off"],
        ],
    },
});

const controls = typeof document === "undefined" ? null : document.querySelector(".guard-controls");

if (controls) {
    const tabs = [...controls.querySelectorAll("[data-guard-mode]")];
    const current = controls.querySelector("[data-guard-current]");
    const panel = document.querySelector("#guard-comparison");
    const description = document.querySelector("[data-guard-description]");
    const verdicts = [...document.querySelectorAll("[data-guard-verdict]")];

    function render(mode, focus = false) {
        const value = GUARD_MODES[mode];
        const activeIndex = tabs.findIndex((tab) => tab.dataset.guardMode === mode);
        current.textContent = mode;
        panel.setAttribute("aria-labelledby", tabs[activeIndex].id);
        description.textContent = value.description;
        tabs.forEach((tab, index) => {
            const active = index === activeIndex;
            tab.setAttribute("aria-selected", String(active));
            tab.tabIndex = active ? 0 : -1;
        });
        verdicts.forEach((verdict, index) => {
            verdict.textContent = value.verdicts[index][0];
            verdict.dataset.tone = value.verdicts[index][1];
        });

        if (focus) {
            tabs[activeIndex].focus();
        }
    }

    tabs.forEach((tab, index) => {
        tab.addEventListener("click", () => render(tab.dataset.guardMode));
        tab.addEventListener("keydown", (event) => {
            let nextIndex;
            if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                nextIndex = (index + 1) % tabs.length;
            }

            if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                nextIndex = (index - 1 + tabs.length) % tabs.length;
            }

            if (event.key === "Home") {
                nextIndex = 0;
            }

            if (event.key === "End") {
                nextIndex = tabs.length - 1;
            }

            if (nextIndex === undefined) {
                return;
            }

            event.preventDefault();
            render(tabs[nextIndex].dataset.guardMode, true);
        });
    });
}

const CYCLE_COPY = Object.freeze([
    {
        authority: "Observed behavior",
        title: "Record observed capability gaps",
        description:
            "When collection is enabled, concrete capability gaps become local, sanitized observations. An observation records a candidate issue without authorizing a change.",
        command: "/wishlist status",
        note: "Collection is opt-in and local.",
    },
    {
        authority: "Evidence gate",
        title: "Qualify recurring evidence",
        description:
            "Repeated, task-deduplicated evidence can qualify an item for consideration. Inspect what happened and whether the existing harness already provides a sufficient answer.",
        command: "/wishlist history [gap-id]",
        note: "Qualification does not authorize work.",
    },
    {
        authority: "Human gate",
        title: "Authorize a specific improvement",
        description:
            "An exact human selection in /harness-improvement authorizes one item. Wishlist evidence alone does not authorize implementation.",
        command: "/harness-improvement",
        note: "Selection authorizes only the chosen item.",
    },
    {
        authority: "Implementation scope",
        title: "Implement the selected scope",
        description:
            "Implement the selected improvement with clear scope and one writer. Preserve unrelated configuration, keep the change reversible, and define how it will be checked.",
        command: "selected → implementation",
        note: "The selected scope bounds the work.",
    },
    {
        authority: "Executable evidence",
        title: "Execute validation and record results",
        description:
            "Actual repository checks and the required registered validator must succeed against the evaluated source. A failed check keeps the item open; model confidence cannot retire it.",
        command: "checks + validator + source fingerprints",
        note: "A receipt proves the bounded check result.",
    },
    {
        authority: "Verified closure",
        title: "Retire the verified item",
        description:
            "Retire the selected item only after its required evidence is accepted. The record retains the connection between the observed gap, the change, and its validation.",
        command: "verifying → retired",
        note: "Retirement is not proof of future usefulness.",
    },
    {
        authority: "Later human feedback",
        title: "Record post-retirement outcomes",
        description:
            "Record whether the change helped, failed, was not exercised, or was reverted. Negative evidence can return a retired item to review. Another implementation still needs human selection.",
        command: "outcome → review → human selection",
        note: "Further implementation requires a new selection.",
    },
]);

const cycleControls = typeof document === "undefined" ? null : document.querySelector(".cycle-tabs");

if (cycleControls) {
    const tabs = [...cycleControls.querySelectorAll("[data-cycle-step]")];
    const panel = document.querySelector("#cycle-panel");

    function renderCycle(index, focus = false) {
        const value = CYCLE_COPY[index];
        panel.setAttribute("aria-labelledby", tabs[index].id);
        panel.querySelector("[data-cycle-number]").textContent = String(index + 1).padStart(2, "0");
        panel.querySelector("[data-cycle-status]").textContent = CYCLE_STAGES[index].status;

        for (const field of ["authority", "title", "description", "command", "note"]) {
            panel.querySelector(`[data-cycle-${field}]`).textContent = value[field];
        }

        tabs.forEach((tab, tabIndex) => {
            tab.setAttribute("aria-selected", String(tabIndex === index));
            tab.tabIndex = tabIndex === index ? 0 : -1;
        });

        if (focus) {
            tabs[index].focus();
        }
    }

    tabs.forEach((tab, index) => {
        tab.addEventListener("click", () => renderCycle(index));
        tab.addEventListener("keydown", (event) => {
            let nextIndex;
            if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                nextIndex = (index + 1) % tabs.length;
            }

            if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                nextIndex = (index - 1 + tabs.length) % tabs.length;
            }

            if (event.key === "Home") {
                nextIndex = 0;
            }

            if (event.key === "End") {
                nextIndex = tabs.length - 1;
            }

            if (nextIndex === undefined) {
                return;
            }

            event.preventDefault();
            renderCycle(nextIndex, true);
        });
    });
}

const copyButtons = typeof document === "undefined" ? [] : document.querySelectorAll("[data-copy-target]");

for (const button of copyButtons) {
    const target = document.getElementById(button.dataset.copyTarget);
    const status = document.querySelector("[data-copy-status]");
    button.hidden = false;
    button.addEventListener("click", async () => {
        try {
            await navigator.clipboard.writeText(target.textContent);
            status.textContent = "Commands copied.";
        } catch {
            status.textContent = "Clipboard unavailable. Select and copy the commands in the terminal block.";
        }
    });
}
