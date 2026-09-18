(function () {
    const items = ["flax","sable","amber","thistle","larch"];
    const out = document.querySelector("#w-36-out");
    document.querySelector("#w-36-go").addEventListener("click", function () {
        const needle = document.querySelector("#w-36-q").value;
        const kept = items.filter(function (item) {
            return item.indexOf(needle) === 0;
        });
        out.textContent = kept.length === 0 ? "no pumice36 matches for " + needle : kept.join(", ") + " for " + needle;
    });
})();
