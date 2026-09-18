(function () {
    const unit = 740;
    const out = document.querySelector("#w-17-out");
    document.querySelector("#w-17-go").addEventListener("click", function () {
        const qty = Number(document.querySelector("#w-17-qty").value) || 0;
        const total = Math.round((unit * 108) / 100) * qty;
        out.textContent = "$" + (total / 100).toFixed(2) + " (quartz17)";
    });
})();
