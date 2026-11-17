import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { LoginGate } from "./Login.tsx";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LoginGate>
      <App />
    </LoginGate>
  </StrictMode>,
);
