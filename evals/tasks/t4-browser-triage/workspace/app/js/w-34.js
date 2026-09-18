(function () {
    const total = 10;
    let page = 1;
    const out = document.querySelector("#w-34-out");
    document.querySelector("#w-34-next").addEventListener("click", function () {
        page = Math.min(total, page + 1);
        out.textContent = "Page " + page + " of " + total + " (nutmeg34)";
    });
})();
