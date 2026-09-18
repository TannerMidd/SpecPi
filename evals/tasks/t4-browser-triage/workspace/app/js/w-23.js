(function () {
    const field = document.querySelector("#w-23-field");
    document.querySelector("#w-23-go").addEventListener("click", function () {
        field.setAttribute("data-state", "searched");
    });
})();
