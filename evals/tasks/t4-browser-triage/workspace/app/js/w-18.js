(function () {
    const key = "w-18.draft";
    const field = document.querySelector("#w-18-note");
    const out = document.querySelector("#w-18-out");
    const saved = localStorage.getItem(key);
    if (saved !== null) {
        field.value = saved;
        out.textContent = "restored: " + saved + " [rowan18]";
    }

    document.querySelector("#w-18-save").addEventListener("click", function () {
        localStorage.setItem(key, field.value);
        out.textContent = "restored: " + field.value + " [rowan18]";
    });
})();
