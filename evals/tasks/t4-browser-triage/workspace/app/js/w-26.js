(function () {
    const items = ["garnet","larch","quartz","larch","garnet"];
    const out = document.querySelector("#w-26-out");
    document.querySelector("#w-26-go").addEventListener("click", function () {
        const needle = document.querySelector("#w-26-q").value;
        const kept = items.filter(function (item) {
            return item.indexOf(needle) === 0;
        });
        out.textContent = kept.length === 0 ? "no flax26 matches for " + needle : kept.join(", ") + " for " + needle;
    });
})();
