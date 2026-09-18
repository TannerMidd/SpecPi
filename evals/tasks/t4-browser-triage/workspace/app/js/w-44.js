(function () {
    const out = document.querySelector("#w-44-out");
    function renderPanel44(node) {
        return (node === null ? "default" : node.textContent) + " (damask44)";
    }

    document.querySelector("#w-44-apply").addEventListener("click", function () {
        const saved = document.querySelector("#w-44-saved");
        out.textContent = renderView44(saved);
    });
})();
