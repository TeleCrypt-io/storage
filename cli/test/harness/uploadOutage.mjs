// Keep the real media upload and attachment, then fail the listing write and
// its automatic media cleanup so the CLI must expose a retryable partial result.
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const pathname = decodeURIComponent(new URL(url).pathname);
  const status = init?.method === "PUT" && pathname.includes("/state/org.matrix.msc3089.branch/")
    ? 403
    : init?.method === "POST" && pathname.endsWith("/io.telecrypt.storage/delete_media")
      ? 503
      : undefined;
  if (status) {
    return new Response(JSON.stringify({ errcode: status === 403 ? "M_FORBIDDEN" : "M_UNKNOWN", error: "test upload outage" }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
  return originalFetch(input, init);
};
