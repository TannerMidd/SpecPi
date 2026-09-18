(function () {
    const out = document.querySelector("#w-29-out");
    document.querySelector("#w-29-go").addEventListener("click", function () {
        const value = document.querySelector("#w-29-mail").value;
        if (value.indexOf("@") < 0) {
            out.textContent = "Invalid address (indigo29)";

            return;
        }
        out.textContent = "Saved " + value + " (indigo29)";
    });
})();
