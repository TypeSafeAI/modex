import React from "react";
import { createRoot } from "react-dom/client";
import { UsageDashboard } from "./UsageDashboard";
import { sampleEvents } from "./sample";
import "./usage.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <UsageDashboard events={sampleEvents} />
  </React.StrictMode>,
);
