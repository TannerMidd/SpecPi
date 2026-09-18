(function () {
    const out = document.querySelector("#w-21-out");
    function renderPanel21(node) {
        return (node === null ? "default" : node.textContent) + " (amber21)";
    }

    document.querySelector("#w-21-apply").addEventListener("click", function () {
        const saved = document.querySelector("#w-21-saved");
        out.textContent = renderView21(saved);
    });
})();
