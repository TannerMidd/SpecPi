(function () {
    const out = document.querySelector("#w-38-out");
    document.querySelector("#w-38-go").addEventListener("click", function () {
        const value = document.querySelector("#w-38-mail").value;
        if (value.length === 0) {
            out.textContent = "Invalid address (rowan38)";

            return;
        }
        out.textContent = "Saved " + value + " (rowan38)";
    });
})();
