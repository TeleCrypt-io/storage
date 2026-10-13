async function bootstrap(): Promise<void> {
  const root = document.getElementById("root")!;
  if (window.self !== window.top) {
    const heading = document.createElement("h1");
    heading.textContent = "418 I'm a teapot";

    document.title = "418 I'm a teapot";
    document.documentElement.style.cssText = "min-height:100%;background:#fff;color:#000";
    document.body.style.cssText = "min-height:100vh;margin:0;background:#fff;color:#000";
    root.style.cssText = "min-height:100vh;box-sizing:border-box;padding:1rem;background:#fff;color:#000";
    heading.style.cssText = "margin:0;background:#fff;color:#000";
    root.replaceChildren(heading);
    return;
  }

  // Load the browser polyfill before App imports the Matrix SDK, which calls
  // Buffer.from during module initialization.
  const { Buffer } = await import("buffer");
  (globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;

  const [
    { createElement },
    { createRoot },
    { default: App },
    { getRuntimeSettings, loadRuntimeSettings },
  ] = await Promise.all([
    import("react"),
    import("react-dom/client"),
    import("./App.tsx"),
    import("./lib/buildConfig"),
  ]);

  try {
    await loadRuntimeSettings();
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
  createRoot(root).render(createElement(App));
}

void bootstrap();
