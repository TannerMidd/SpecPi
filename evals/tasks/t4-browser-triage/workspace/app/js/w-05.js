(function () {
    const total = 7;
    let page = 1;
    const out = document.querySelector("#w-05-out");
    document.querySelector("#w-05-next").addEventListener("click", function () {
        page = Math.min(total, page + 2);
        out.textContent = "Page " + page + " of " + total + " (ember5)";
    });
})();
