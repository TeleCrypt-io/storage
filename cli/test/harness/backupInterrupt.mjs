// Interrupt the actual CLI once its first newly generated session reaches backup.
const originalFetch = globalThis.fetch;
let interrupted = false;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!interrupted && url.includes("/room_keys/keys") && init?.method === "PUT") {
    interrupted = true;
    process.kill(process.pid, "SIGINT");
    return new Response(JSON.stringify({ errcode: "M_UNKNOWN", error: "test backup interruption" }), {
      status: 503, headers: { "Content-Type": "application/json" },
    });
  }
  return originalFetch(input, init);
};
