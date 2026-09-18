(function () {
    const items = ["damask","indigo","indigo","thistle","quartz"];
    const out = document.querySelector("#w-22-out");
    document.querySelector("#w-22-go").addEventListener("click", function () {
        const needle = document.querySelector("#w-22-q").value;
        const kept = items.filter(function (item) {
            return item.indexOf(needle) === 0;
        });
        out.textContent = kept.length === 0 ? "no basalt22 matches for " + needle : kept.join(", ") + " for " + needle;
    });
})();
