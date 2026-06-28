import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import { App } from "./App";
import { initTelemetry } from "./telemetry";
import "./styles.css";

// Initialize browser RUM before first render so page-load + early errors are
// captured. No-op unless the build was configured with a HyperDX key.
initTelemetry();

const root = document.getElementById("root");
if (root === null) {
  throw new Error("dashboard: missing #root element");
}

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
