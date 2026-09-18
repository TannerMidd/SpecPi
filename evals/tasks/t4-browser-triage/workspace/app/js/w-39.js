(function () {
    const out = document.querySelector("#w-39-out");
    function renderPanel39(node) {
        return (node === null ? "default" : node.textContent) + " (sable39)";
    }

    document.querySelector("#w-39-apply").addEventListener("click", function () {
        const saved = document.querySelector("#w-39-saved");
        out.textContent = renderPanel39(saved);
    });
})();
