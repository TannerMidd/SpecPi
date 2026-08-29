export const CYCLE_STAGES = Object.freeze([
    {
      stage: "01 / friction",
      headline: "A real task hits a real limit.",
      copy: "A responsive page needs rendered desktop and mobile inspection, but no local browser is available.",
      action: "record one sanitized local signal",
      boundary: "No work begins. One report is evidence, not authority.",
      status: "open",
      signal: "Signal recorded locally",
      tasks: "1",
      projects: "1",
      impact: "degraded",
      progress: "18%",
      nextLabel: "add a second task",
    },
    {
      stage: "02 / repeat",
      headline: "Another task proves the gap is reusable.",
      copy: "The same limitation appears again. Distinct tasks, projects, impact, and recency now make the signal worth attention.",
      action: "qualify the item for the improvement menu",
      boundary: "Qualification recommends work. It does not grant permission to start it.",
      status: "qualified",
      signal: "Recurring evidence earns priority",
      tasks: "2",
      projects: "2",
      impact: "degraded",
      progress: "38%",
      nextLabel: "choose one item",
    },
    {
      stage: "03 / choose",
      headline: "A person chooses exactly one improvement.",
      copy: "The /harness-improvement menu shows the evidence. Selecting this item authorizes only its smallest sufficient intervention.",
      action: "record the exact human choice",
      boundary: "No adjacent feature, install, upload, or remote change is included.",
      status: "selected",
      signal: "One bounded change is authorized",
      tasks: "2",
      projects: "2",
      impact: "degraded",
      progress: "52%",
      nextLabel: "build the smallest change",
    },
    {
      stage: "04 / build",
      headline: "The smallest sufficient capability is implemented.",
      copy: "The agent inspects the current harness, rejects feature accumulation, adds focused tests, and keeps a clean rollback path.",
      action: "implement only what the evidence supports",
      boundary: "The item stays selected. Plausible code is not proof that the gap is closed.",
      status: "selected",
      signal: "Implementation ready for proof",
      tasks: "2",
      projects: "2",
      impact: "degraded",
      progress: "69%",
      nextLabel: "run the proof gate",
    },
    {
      stage: "05 / prove",
      headline: "Behavior—not confidence—decides the outcome.",
      copy: "The completion gate requires registry integration, runs the repository suite, and executes the capability's closed validator.",
      action: "verify the integrated behavior directly",
      boundary: "If any gate fails, retirement is blocked and the item remains selected.",
      status: "verifying",
      signal: "Repository + capability gates",
      tasks: "2",
      projects: "2",
      impact: "degraded",
      progress: "86%",
      nextLabel: "pass and retire",
    },
    {
      stage: "06 / retire",
      headline: "Passing proof closes the active work.",
      copy: "The verified capability leaves the queue. Its evidence and retirement decision remain local, append-only, and reviewable.",
      action: "retire the item with validation evidence",
      boundary: "Retired means integrated and verified—not forgotten or guaranteed forever.",
      status: "retired",
      signal: "Closed with direct evidence",
      tasks: "2",
      projects: "2",
      impact: "degraded",
      progress: "100%",
      nextLabel: "see what later evidence does",
    },
    {
      stage: "07 / return",
      headline: "New friction makes the retired item visible again.",
      copy: "A later task reports the same gap. ZenPi preserves the signal and returns the item to the menu as review-needed.",
      action: "surface the regression for human review",
      boundary: "Nothing reopens itself. Choosing the item again is the next explicit decision.",
      status: "review-needed",
      signal: "Post-retirement evidence needs review",
      tasks: "3",
      projects: "2",
      impact: "degraded",
      progress: "100%",
      nextLabel: "choose it again",
    },
].map((stage) => Object.freeze(stage)));

export function nextCycleStep(current) {
  return current >= CYCLE_STAGES.length - 1 ? 2 : current + 1;
}

export function previousCycleStep(current) {
  return Math.max(0, current - 1);
}

const story = typeof document === "undefined" ? null : document.querySelector("[data-cycle-story]");

if (story) {
  story.classList.add("is-interactive");
  const stages = CYCLE_STAGES;
  const tabs = [...story.querySelectorAll("[data-cycle-step]")];
  const panel = story.querySelector("#cycle-story-panel");
  const fields = {
    stage: story.querySelector("[data-story-stage]"),
    headline: story.querySelector("[data-story-headline]"),
    copy: story.querySelector("[data-story-copy]"),
    action: story.querySelector("[data-story-action]"),
    boundary: story.querySelector("[data-story-boundary]"),
    status: story.querySelector("[data-story-status]"),
    signal: story.querySelector("[data-story-signal]"),
    meter: story.querySelector("[data-story-meter]"),
    tasks: story.querySelector("[data-story-tasks]"),
    projects: story.querySelector("[data-story-projects]"),
    impact: story.querySelector("[data-story-impact]"),
    count: story.querySelector("[data-story-count]"),
    nextLabel: story.querySelector("[data-story-next-label]"),
    announcement: story.querySelector("[data-story-announcement]"),
  };
  const previous = story.querySelector("[data-story-previous]");
  const next = story.querySelector("[data-story-next]");
  let current = 0;

  tabs.forEach((tab, index) => {
    tab.id = `cycle-story-step-${index + 1}`;
    tab.addEventListener("click", () => render(index));
    tab.addEventListener("keydown", (event) => {
      let target;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") target = (index + 1) % tabs.length;
      if (event.key === "ArrowLeft" || event.key === "ArrowUp") target = (index - 1 + tabs.length) % tabs.length;
      if (event.key === "Home") target = 0;
      if (event.key === "End") target = tabs.length - 1;
      if (target === undefined) return;
      event.preventDefault();
      render(target, true);
      tabs[target].focus();
    });
  });

  function render(index, revealTab = false) {
    current = index;
    const value = stages[index];
    for (const key of ["stage", "headline", "copy", "action", "boundary", "signal", "tasks", "projects", "impact", "nextLabel"]) {
      fields[key].textContent = value[key];
    }
    fields.status.textContent = value.status;
    fields.status.dataset.status = value.status;
    fields.meter.style.setProperty("--story-progress", value.progress);
    fields.count.textContent = String(index + 1);
    fields.announcement.textContent = `${value.stage}. ${value.headline} Status: ${value.status}. ${value.boundary}`;
    tabs.forEach((tab, tabIndex) => {
      const active = tabIndex === index;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    panel.setAttribute("aria-labelledby", tabs[index].id);
    previous.disabled = index === 0;
    next.innerHTML = index === stages.length - 1
      ? 'Choose again <span aria-hidden="true">↻</span>'
      : 'Next <span aria-hidden="true">→</span>';
    if (revealTab) {
      const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
      tabs[index].scrollIntoView({ behavior, block: "nearest", inline: "center" });
    }
  }

  previous.addEventListener("click", () => render(previousCycleStep(current), true));
  next.addEventListener("click", () => render(nextCycleStep(current), true));
  render(0);
}
