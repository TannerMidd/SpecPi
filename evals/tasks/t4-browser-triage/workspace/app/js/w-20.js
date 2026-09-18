(function () {
    const toggle = document.querySelector("#w-20-toggle");
    const panel = document.querySelector("#w-20-panel");
    toggle.addEventListener("click", function () {
        const open = panel.hidden;
        panel.hidden = !open;
        toggle.setAttribute("aria-expanded", String(open));
    });
})();
