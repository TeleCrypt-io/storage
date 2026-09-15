// Buffer polyfill: matrix-js-sdk / matrix-encrypt-attachment call Buffer.from()
// directly (Node-ism), which does not exist in a browser. Must be wired up
// before anything from matrix-js-sdk runs.
import { Buffer } from "buffer";
(globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;

import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { getRuntimeSettings } from "./lib/buildConfig";

async function bootstrap(): Promise<void> {
  const root = document.getElementById("root")!;
  try {
    getRuntimeSettings();
  } catch (error) {
    // Do not render a login screen or accept a saved session until the page
    // origin has been bound to an allowed environment.
    console.error("Storage page environment is invalid", error);
    root.textContent = "Storage is unavailable: this page is not an allowed TeleCrypt environment.";
    return;
  }

  // Deliberately no <StrictMode>: it double-invokes effects in dev, which would
  // build two MatrixClients (two crypto stores, two sync loops) for one mount.
  createRoot(root).render(<App />);
}

void bootstrap();
