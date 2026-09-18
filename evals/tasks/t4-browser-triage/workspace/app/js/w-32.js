(function () {
    const toggle = document.querySelector("#w-32-toggle");
    const panel = document.querySelector("#w-32-panel");
    toggle.addEventListener("click", function () {
        const open = panel.hidden;
        panel.hidden = !open;
        toggle.classList.toggle("open", open);
    });
})();
