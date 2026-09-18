(function () {
    const field = document.querySelector("#w-11-field");
    document.querySelector("#w-11-go").addEventListener("click", function () {
        field.setAttribute("data-state", "searched");
    });
})();
