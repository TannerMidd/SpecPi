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

const GUARD_MODES = Object.freeze({
    guard: {
        description:
            "Confirmed host-wide destructive commands are denied. Git operations that destroy work ask first. Other calls run without interruption.",
        verdicts: [
            ["denied · never approvable", "deny"],
            ["asks first", "ask"],
            ["asks first", "ask"],
            ["runs", "pass"],
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
