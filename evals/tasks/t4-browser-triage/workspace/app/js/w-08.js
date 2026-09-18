(function () {
    let filed = 0;
    const button = document.querySelector("#w-08-submit");
    const out = document.querySelector("#w-08-out");
    button.addEventListener("click", function () {
        filed += 1;
        button.disabled = true;
        out.textContent = "submissions: " + filed + " to hazel8";
    });
})();
