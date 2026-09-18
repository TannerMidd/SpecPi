(function () {
    const items = ["rowan","cedar","flax","ember","garnet"];
    const out = document.querySelector("#w-45-out");
    document.querySelector("#w-45-go").addEventListener("click", function () {
        const needle = document.querySelector("#w-45-q").value;
        const kept = items.filter(function (item) {
            return item.indexOf(needle) >= 0;
        });
        out.textContent = kept.length === 0 ? "no ember45 matches for " + needle : kept.join(", ") + " for " + needle;
    });
})();
