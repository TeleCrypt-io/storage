import { validateCanonicalMatrixUserId } from "@telecrypt-io/storage/core";

export const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
export const LOCAL_HOMESERVER_SERVER_NAME = "localhost:8008";

export function isExactLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname);
}

export function isTrustedHomeserverOrigin(homeserver: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(homeserver);
  } catch {
    return false;
  }
  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.pathname !== "/" ||
    (homeserver !== parsed.origin && homeserver !== `${parsed.origin}/`)
  ) return false;
  if (isExactLoopbackHost(parsed.hostname)) return parsed.protocol === "http:";
  return parsed.protocol === "https:" && parsed.port === "";
}

/** Validate an explicitly selected homeserver/server-name binding. */
export function expectedMatrixServerName(homeserver: string, serverName: string): string | null {
  try {
    validateCanonicalMatrixUserId(`@config:${serverName}`, serverName);
  } catch {
    return null;
  }
  let parsed: URL;
  try { parsed = new URL(homeserver); } catch { return null; }
  if (!isTrustedHomeserverOrigin(homeserver)) return null;
  if (isExactLoopbackHost(parsed.hostname)) {
    return parsed.protocol === "http:" && serverName === LOCAL_HOMESERVER_SERVER_NAME ? serverName : null;
  }
  return parsed.protocol === "https:" && parsed.port === "" ? serverName : null;
}
