/**
 * Derive the only permitted Matrix homeserver from the page origin. There is
 * deliberately no external configuration file: a static artifact must not carry a
 * second, independently mutable environment selector.
 */
export interface RuntimeSettings {
  homeserver: string;
  serverName: string;
}

const STORAGE_ENVIRONMENTS = new Map<string, RuntimeSettings>([
  ["storage.telecrypt.io", { homeserver: "https://backend.telecrypt.io", serverName: "telecrypt.io" }],
  [
    "storage.stage.telecrypt.io",
    { homeserver: "https://backend.stage.telecrypt.io", serverName: "stage.telecrypt.io" },
  ],
]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const DEVELOPMENT_HOMESERVER = "http://localhost:8008";
const DEVELOPMENT_SERVER_NAME = "localhost:8008";

function deriveRuntimeSettings(origin: string, development: boolean): RuntimeSettings {
  let page: URL;
  try {
    page = new URL(origin);
  } catch {
    throw new Error("Storage page origin is invalid");
  }

  const hostname = page.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    development &&
    page.protocol === "http:" &&
    page.username === "" &&
    page.password === "" &&
    origin === page.origin &&
    LOOPBACK_HOSTS.has(hostname)
  ) {
    // The disposable Matrix fixture uses the homeserver authority as its canonical
    // server name even when the browser reaches the UI through another loopback alias.
    return { homeserver: DEVELOPMENT_HOMESERVER, serverName: DEVELOPMENT_SERVER_NAME };
  }
  if (
    page.protocol !== "https:" ||
    page.username !== "" ||
    page.password !== "" ||
    page.port !== "" ||
    origin !== page.origin
  ) {
    throw new Error("Storage page must use canonical HTTPS TeleCrypt hosting");
  }

  const environment = STORAGE_ENVIRONMENTS.get(hostname);
  if (!environment) {
    throw new Error("Storage page host is not an allowed TeleCrypt environment");
  }
  return environment;
}

export function runtimeOidcIssuer(): string {
  return `${getRuntimeSettings().homeserver}/auth/`;
}

export function getRuntimeSettings(): RuntimeSettings {
  return deriveRuntimeSettings(window.location.origin, import.meta.env.DEV);
}

export function assertRuntimeOidcEndpoint(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} is missing from OIDC discovery`);
  const issuer = new URL(runtimeOidcIssuer());
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (
    endpoint.protocol !== issuer.protocol ||
    endpoint.origin !== issuer.origin ||
    !endpoint.pathname.startsWith(issuer.pathname) ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.port !== issuer.port ||
    endpoint.search !== "" ||
    endpoint.hash !== "" ||
    endpoint.toString() !== value
  ) {
    throw new Error(`${name} must remain on the configured OIDC origin and /auth/ path`);
  }
  return value;
}
