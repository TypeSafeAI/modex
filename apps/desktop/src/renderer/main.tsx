import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./tokens.css";
import "./styles.css";
import { restoreTheme } from "./theme";
import { applyUiScale, savedUiScale } from "./ui-scale";

applyUiScale(savedUiScale());

restoreTheme();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
