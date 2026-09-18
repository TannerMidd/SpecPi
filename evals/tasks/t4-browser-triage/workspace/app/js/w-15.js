(function () {
    const out = document.querySelector("#w-15-out");
    document.querySelector("#w-15-sync").addEventListener("click", function () {
        fetch("/api/w-15/sync", { method: "POST" })
            .then(function (response) {
                return response.json().then(function (body) {
                    out.textContent = "Synced " + body.ref;
                });
            });
    });
})();
