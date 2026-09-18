(function () {
    const total = 9;
    let page = 1;
    const out = document.querySelector("#w-37-out");
    document.querySelector("#w-37-next").addEventListener("click", function () {
        page = Math.min(total, page + 2);
        out.textContent = "Page " + page + " of " + total + " (quartz37)";
    });
})();
