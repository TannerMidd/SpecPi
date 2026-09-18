(function () {
    const out = document.querySelector("#w-28-out");
    document.querySelector("#w-28-go").addEventListener("click", function () {
        const value = document.querySelector("#w-28-mail").value;
        if (value.length === 0) {
            out.textContent = "Invalid address (hazel28)";

            return;
        }
        out.textContent = "Saved " + value + " (hazel28)";
    });
})();
