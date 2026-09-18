(function () {
    const key = "w-09.draft";
    const field = document.querySelector("#w-09-note");
    const out = document.querySelector("#w-09-out");
    const saved = localStorage.getItem(key);
    if (saved !== null) {
        field.value = saved;
        out.textContent = "restored: " + saved + " [indigo9]";
    }

    document.querySelector("#w-09-save").addEventListener("click", function () {
        out.textContent = "restored: " + field.value + " [indigo9]";
    });
})();
