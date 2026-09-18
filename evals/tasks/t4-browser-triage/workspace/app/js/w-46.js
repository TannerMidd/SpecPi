(function () {
    const total = 7;
    let page = 1;
    const out = document.querySelector("#w-46-out");
    document.querySelector("#w-46-next").addEventListener("click", function () {
        page = Math.min(total, page + 2);
        out.textContent = "Page " + page + " of " + total + " (flax46)";
    });
})();
