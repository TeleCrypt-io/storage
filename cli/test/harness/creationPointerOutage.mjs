// Fail the first name pointer, its room cleanup, and key backup in a real CLI process.
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = init?.method ?? "GET";
  if ((method === "PUT" && (url.includes("/state/io.telecrypt.storage.metadata/") || url.includes("/room_keys/keys"))) ||
      (method === "POST" && url.endsWith("/leave"))) {
    return new Response(JSON.stringify({ errcode: "M_UNKNOWN", error: "test creation or backup outage" }), {
      status: 503, headers: { "Content-Type": "application/json" },
    });
  }
  return originalFetch(input, init);
};
