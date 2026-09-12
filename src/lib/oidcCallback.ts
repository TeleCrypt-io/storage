const OIDC_CALLBACK_PARAMETERS = [
  "code",
  "state",
  "error",
  "error_description",
  "error_uri",
  "iss",
  "session_state",
] as const;

export type OidcCallbackKind = "none" | "success" | "error" | "malformed";

type OidcCallbackLocation = Pick<Location, "search" | "hash">;

/** Merge query and fragment response parameters while retaining duplicates for strict validation. */
export function readOidcCallbackParams(location: OidcCallbackLocation): URLSearchParams {
  const params = new URLSearchParams(location.search || "");
  const hash = location.hash || "";
  if (hash.startsWith("#")) {
    const fragmentParams = new URLSearchParams(hash.slice(1));
    for (const [key, value] of fragmentParams) {
      params.append(key, value);
    }
  }
  return params;
}

function hasExactlyOne(params: URLSearchParams, name: string): boolean {
  return params.getAll(name).length === 1;
}

export function scrubOidcCallbackParams(location: Pick<Location, "pathname">): void {
  window.history.replaceState({}, "", location.pathname || "/");
}

export function classifyOidcCallback(location: OidcCallbackLocation): OidcCallbackKind {
  const params = readOidcCallbackParams(location);
  const hasRecognized = OIDC_CALLBACK_PARAMETERS.some((name) => params.has(name));
  if (!hasRecognized) return "none";

  for (const name of OIDC_CALLBACK_PARAMETERS) {
    if (params.getAll(name).length > 1) {
      return "malformed";
    }
  }

  const code = hasExactlyOne(params, "code");
  const state = hasExactlyOne(params, "state");
  const error = hasExactlyOne(params, "error");
  if (code && state && !error) {
    if (!params.get("code") || !params.get("state") || params.has("error_description") || params.has("error_uri")) {
      return "malformed";
    }
    return "success";
  }
  if (error && state && !code) {
    if (!params.get("error") || !params.get("state")) return "malformed";
    return "error";
  }
  return "malformed";
}
