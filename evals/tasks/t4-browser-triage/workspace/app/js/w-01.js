(function () {
    const out = document.querySelector("#w-01-out");
    document.querySelector("#w-01-sync").addEventListener("click", function () {
        fetch("/api/w-01/sync", { method: "POST" })
            .then(function (response) {
                return response.json().then(function (body) {
                    out.textContent = (response.ok ? "Synced " : "Sync failed ") + body.ref;
                });
            });
    });
})();
