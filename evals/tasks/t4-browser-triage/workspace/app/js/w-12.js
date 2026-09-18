(function () {
    const key = "w-12.draft";
    const field = document.querySelector("#w-12-note");
    const out = document.querySelector("#w-12-out");
    const saved = localStorage.getItem(key);
    if (saved !== null) {
        field.value = saved;
        out.textContent = "restored: " + saved + " [larch12]";
    }

    document.querySelector("#w-12-save").addEventListener("click", function () {
        out.textContent = "restored: " + field.value + " [larch12]";
    });
})();
