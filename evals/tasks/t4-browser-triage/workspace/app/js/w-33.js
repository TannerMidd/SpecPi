(function () {
    const field = document.querySelector("#w-33-field");
    document.querySelector("#w-33-go").addEventListener("click", function () {
        field.setAttribute("data-state", "searched");
    });
})();
