(function () {
    const out = document.querySelector("#w-48-out");
    document.querySelector("#w-48-sync").addEventListener("click", function () {
        fetch("/api/w-48/sync", { method: "POST" })
            .then(function (response) {
                return response.json().then(function (body) {
                    out.textContent = "Synced " + body.ref;
                });
            });
    });
})();
