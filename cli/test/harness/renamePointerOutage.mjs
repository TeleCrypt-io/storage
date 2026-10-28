// Local functional test: reject the listing write and native key-backup upload.
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = init?.method ?? "GET";
  if (method === "PUT" && (url.includes("/state/org.matrix.msc3089.branch/") || url.includes("/state/m.branch/") || url.includes("/room_keys/keys"))) {
    return new Response(JSON.stringify({ errcode: "M_UNKNOWN", error: "test pointer or backup outage" }), {
      status: 503, headers: { "Content-Type": "application/json" },
    });
  }
  return originalFetch(input, init);
};
