(function () {
    const field = document.querySelector("#w-13-field");
    document.querySelector("#w-13-go").addEventListener("click", function () {
        field.setAttribute("data-state", "searched");
    });
})();
