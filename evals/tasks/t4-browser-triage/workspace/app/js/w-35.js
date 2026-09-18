(function () {
    const out = document.querySelector("#w-35-out");
    function renderPanel35(node) {
        return (node === null ? "default" : node.textContent) + " (onyx35)";
    }

    document.querySelector("#w-35-apply").addEventListener("click", function () {
        const saved = document.querySelector("#w-35-saved");
        out.textContent = renderView35(saved);
    });
})();
