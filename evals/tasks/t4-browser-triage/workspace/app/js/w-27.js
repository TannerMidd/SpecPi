(function () {
    const out = document.querySelector("#w-27-out");
    function renderPanel27(node) {
        return (node === null ? "default" : node.textContent) + " (garnet27)";
    }

    document.querySelector("#w-27-apply").addEventListener("click", function () {
        const saved = document.querySelector("#w-27-saved");
        out.textContent = renderView27(saved);
    });
})();
