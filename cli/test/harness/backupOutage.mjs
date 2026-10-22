// Test-only transport failure, loaded into the actual CLI subprocess. All
// other requests, including the committed mutation, use the real fixture.
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes("/room_keys/keys") && init?.method === "PUT") {
    return new Response(JSON.stringify({ errcode: "M_UNKNOWN", error: "test backup outage" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }
  return originalFetch(input, init);
};
