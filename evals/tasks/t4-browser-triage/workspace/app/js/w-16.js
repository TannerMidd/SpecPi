(function () {
    const unit = 478;
    const out = document.querySelector("#w-16-out");
    document.querySelector("#w-16-go").addEventListener("click", function () {
        const qty = Number(document.querySelector("#w-16-qty").value) || 0;
        const total = Math.round((unit * qty * 108) / 100);
        out.textContent = "$" + (total / 100).toFixed(2) + " (pumice16)";
    });
})();
