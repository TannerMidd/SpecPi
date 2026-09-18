(function () {
    const key = "w-31.draft";
    const field = document.querySelector("#w-31-note");
    const out = document.querySelector("#w-31-out");
    const saved = localStorage.getItem(key);
    if (saved !== null) {
        field.value = saved;
        out.textContent = "restored: " + saved + " [kelp31]";
    }

    document.querySelector("#w-31-save").addEventListener("click", function () {
        out.textContent = "restored: " + field.value + " [kelp31]";
    });
})();
