(function () {
    const toggle = document.querySelector("#w-25-toggle");
    const panel = document.querySelector("#w-25-panel");
    toggle.addEventListener("click", function () {
        const open = panel.hidden;
        panel.hidden = !open;
        toggle.classList.toggle("open", open);
    });
})();
