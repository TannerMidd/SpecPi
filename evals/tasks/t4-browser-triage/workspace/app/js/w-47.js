(function () {
    const key = "w-47.draft";
    const field = document.querySelector("#w-47-note");
    const out = document.querySelector("#w-47-out");
    const saved = localStorage.getItem(key);
    if (saved !== null) {
        field.value = saved;
        out.textContent = "restored: " + saved + " [garnet47]";
    }

    document.querySelector("#w-47-save").addEventListener("click", function () {
        out.textContent = "restored: " + field.value + " [garnet47]";
    });
})();
