const filters = document.querySelector("[data-eval-filters]");
if (filters instanceof HTMLFormElement) {
    const rows = [...document.querySelectorAll("[data-eval-task]")];
    const count = document.querySelector("[data-eval-count]");
    const update = () => {
        const values = new FormData(filters);
        const difficulty = values.get("difficulty");
        const control = values.get("control");
        const search = String(values.get("search") ?? "")
            .trim()
            .toLowerCase();
        let visible = 0;
        for (const row of rows) {
            row.hidden =
                !(difficulty === "all" || difficulty === row.dataset.difficulty) ||
                !(control === "all" || control === row.dataset.control) ||
                !row.dataset.search.toLowerCase().includes(search);
            if (!row.hidden) {
                visible += 1;
            }
        }

        count.textContent = `Showing ${visible} of ${rows.length} tasks.`;
    };

    filters.addEventListener("input", update);
    filters.addEventListener("change", update);
    filters.addEventListener("reset", (event) => {
        event.preventDefault();
        filters.elements.namedItem("difficulty").value = "all";
        filters.elements.namedItem("control").value = "all";
        filters.elements.namedItem("search").value = "";
        update();
    });
    filters.addEventListener("submit", (event) => event.preventDefault());
    filters.hidden = false;
    update();
}
