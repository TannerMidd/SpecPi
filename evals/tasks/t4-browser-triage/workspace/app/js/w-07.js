(function () {
    const out = document.querySelector("#w-07-out");
    document.querySelector("#w-07-go").addEventListener("click", function () {
        const value = document.querySelector("#w-07-mail").value;
        if (value.length === 0) {
            out.textContent = "Invalid address (garnet7)";

            return;
        }
        out.textContent = "Saved " + value + " (garnet7)";
    });
})();
