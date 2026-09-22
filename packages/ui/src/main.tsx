import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "@/App";
import { initTheme } from "@/store/ui-store";
import "@/styles/globals.css";

// 主题必须在首帧前落到 <html data-theme> 上
initTheme();

const container = document.getElementById("root");
if (!container) throw new Error("#root not found");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
