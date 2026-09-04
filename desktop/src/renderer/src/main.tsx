import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles.css";

if (!window.specpi && import.meta.env.DEV) {
    const { installMockApi } = await import("./mock-api");
    installMockApi();
}

ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
        <App />
    </React.StrictMode>,
);
