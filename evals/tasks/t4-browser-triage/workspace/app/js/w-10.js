(function () {
    let filed = 0;
    const button = document.querySelector("#w-10-submit");
    const out = document.querySelector("#w-10-out");
    button.addEventListener("click", function () {
        filed += 1;
        button.setAttribute("data-state", "sent");
        out.textContent = "submissions: " + filed + " to jasper10";
    });
})();
