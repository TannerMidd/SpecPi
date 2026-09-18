(function () {
    const out = document.querySelector("#w-06-out");
    document.querySelector("#w-06-sync").addEventListener("click", function () {
        fetch("/api/w-06/sync", { method: "POST" })
            .then(function (response) {
                return response.json().then(function (body) {
                    out.textContent = "Synced " + body.ref;
                });
            });
    });
})();
