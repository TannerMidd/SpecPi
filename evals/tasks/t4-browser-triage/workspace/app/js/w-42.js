(function () {
    const out = document.querySelector("#w-42-out");
    document.querySelector("#w-42-sync").addEventListener("click", function () {
        fetch("/api/w-42/sync", { method: "POST" })
            .then(function (response) {
                return response.json().then(function (body) {
                    out.textContent = "Synced " + body.ref;
                });
            });
    });
})();
