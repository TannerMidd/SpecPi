(function () {
    const unit = 365;
    const out = document.querySelector("#w-19-out");
    document.querySelector("#w-19-go").addEventListener("click", function () {
        const qty = Number(document.querySelector("#w-19-qty").value) || 0;
        const total = Math.round((unit * 108) / 100) * qty;
        out.textContent = "$" + (total / 100).toFixed(2) + " (sable19)";
    });
})();
