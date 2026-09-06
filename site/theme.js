// Apply the saved choice before styles load, so navigation keeps the same theme.
(() => {
    const root = document.documentElement;
    const storageKey = "specpi-site-theme";
    let theme = "light";
    try {
        if (localStorage.getItem(storageKey) === "dark") {
            theme = "dark";
        }
    } catch {
        // The control still works when browser storage is unavailable.
    }

    root.dataset.theme = theme;

    document.addEventListener("DOMContentLoaded", () => {
        const toggle = document.querySelector(".theme-toggle");
        const themeColor = document.querySelector('meta[name="theme-color"]');
        function renderTheme() {
            toggle?.setAttribute("aria-pressed", String(theme === "dark"));
            themeColor?.setAttribute("content", theme === "dark" ? "#111419" : "#fafbfc");
        }

        renderTheme();
        if (toggle) {
            toggle.hidden = false;
            toggle.addEventListener("click", () => {
                theme = theme === "light" ? "dark" : "light";
                root.dataset.theme = theme;
                renderTheme();
                try {
                    localStorage.setItem(storageKey, theme);
                } catch {
                    // Keep the choice for this page even without persistence.
                }
            });
        }

        function revealFragment() {
            let id;
            try {
                id = decodeURIComponent(location.hash.slice(1));
            } catch {
                return;
            }

            const target = document.getElementById(id);
            if (!target) {
                return;
            }

            let parent = target;
            while (parent) {
                if (parent instanceof HTMLDetailsElement) {
                    parent.open = true;
                }

                parent = parent.parentElement;
            }
        }

        revealFragment();
        window.addEventListener("hashchange", revealFragment);
    });
})();
