(function () {
    const items = ["quartz","ember","garnet","nutmeg","rowan"];
    const out = document.querySelector("#w-14-out");
    document.querySelector("#w-14-go").addEventListener("click", function () {
        const needle = document.querySelector("#w-14-q").value;
        const kept = items.filter(function (item) {
            return item.indexOf(needle) === 0;
        });
        out.textContent = kept.length === 0 ? "no nutmeg14 matches for " + needle : kept.join(", ") + " for " + needle;
    });
})();
