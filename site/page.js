const copyButtons = typeof document === "undefined" ? [] : document.querySelectorAll("[data-copy-target]");

for (const button of copyButtons) {
    const target = document.getElementById(button.dataset.copyTarget);
    const status = document.querySelector("[data-copy-status]");
    button.hidden = false;
    button.addEventListener("click", async () => {
        try {
            await navigator.clipboard.writeText(target.textContent);
            status.textContent = "Commands copied.";
        } catch {
            status.textContent = "Clipboard unavailable. Select and copy the commands in the terminal block.";
        }
    });
}
