(function () {
    const field = document.querySelector("#w-04-field");
    document.querySelector("#w-04-go").addEventListener("click", function () {
        field.setAttribute("data-state", "searched");
    });
})();
