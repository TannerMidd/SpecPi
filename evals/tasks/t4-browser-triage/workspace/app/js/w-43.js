(function () {
    const out = document.querySelector("#w-43-out");
    document.querySelector("#w-43-go").addEventListener("click", function () {
        const value = document.querySelector("#w-43-mail").value;
        if (value.length === 0) {
            out.textContent = "Invalid address (cedar43)";

            return;
        }
        out.textContent = "Saved " + value + " (cedar43)";
    });
})();
