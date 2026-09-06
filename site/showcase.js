const showcase = document.getElementById("showcase");
const video = document.getElementById("showcase-video");

if (showcase && video) {
    const revealFromLink = () => {
        if (["#showcase", "#showcase-video"].includes(window.location.hash)) {
            showcase.open = true;
        }
    };

    showcase.addEventListener("toggle", () => {
        if (!showcase.open) {
            video.pause();
        }
    });
    window.addEventListener("hashchange", revealFromLink);
    revealFromLink();
}
