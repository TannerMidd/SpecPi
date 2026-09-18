(function () {
    const total = 10;
    let page = 1;
    const out = document.querySelector("#w-24-out");
    document.querySelector("#w-24-next").addEventListener("click", function () {
        page = Math.min(total, page + 2);
        out.textContent = "Page " + page + " of " + total + " (damask24)";
    });
})();
