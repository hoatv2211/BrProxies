import React from "react";
import ReactDOM from "react-dom/client";
// Flat square country flag sprites (we use the `.fis` square variant).
// Pulls in ~80KB minified CSS + CSS-only SVG-data-URI flags for every
// country — no runtime fetch, works offline in the launcher webview.
import "flag-icons/css/flag-icons.min.css";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
