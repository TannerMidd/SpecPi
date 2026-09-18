(function () {
    const toggle = document.querySelector("#w-03-toggle");
    const panel = document.querySelector("#w-03-panel");
    toggle.addEventListener("click", function () {
        const open = panel.hidden;
        panel.hidden = !open;
        toggle.classList.toggle("open", open);
    });
})();
