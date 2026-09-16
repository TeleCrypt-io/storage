import { validateCanonicalMatrixUserId } from "./core";

/** Runtime deployment identity rendered into config.json by the hosting deployment. */
export interface RuntimeSettings {
  homeserver: string;
  serverName: string;
}

interface DeploymentConfig {
  serverName: string;
}

const CONFIG_PATH = "/config.json";
const DEVELOPMENT_HOMESERVER = "http://localhost:8008";
const DEVELOPMENT_SERVER_NAME = "localhost:8008";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
let loadedSettings: RuntimeSettings | undefined;

function developmentSettings(): RuntimeSettings {
  const page = new URL(window.location.origin);
  const hostname = page.hostname.replace(/^\[|\]$/gu, "");
  if (
    page.protocol !== "http:" ||
    page.username !== "" ||
    page.password !== "" ||
    page.origin !== window.location.origin ||
    !LOOPBACK_HOSTS.has(hostname)
  ) {
    throw new Error("Storage page host is not an allowed TeleCrypt environment");
  }
  return { homeserver: DEVELOPMENT_HOMESERVER, serverName: DEVELOPMENT_SERVER_NAME };
}

function isDevelopment(): boolean {
  return import.meta.env.DEV;
}

function validateServerName(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.includes(":")) {
    throw new Error("Deployment config has an invalid Matrix server name");
  }
  try {
    validateCanonicalMatrixUserId(`@config:${value}`, value);
  } catch (error) {
    throw new Error("Deployment config has an invalid Matrix server name", { cause: error });
  }
  return value;
}

function settingsFromConfig(config: unknown): RuntimeSettings {
  if (typeof config !== "object" || config === null || !("serverName" in config)) {
    throw new Error("Deployment config is invalid");
  }
  const serverName = validateServerName((config as DeploymentConfig).serverName);
  const page = new URL(window.location.origin);
  const expectedHost = `storage.${serverName}`.toLowerCase();
  if (
    page.protocol !== "https:" ||
    page.username !== "" ||
    page.password !== "" ||
    page.port !== "" ||
    page.hostname.toLowerCase() !== expectedHost ||
    page.origin !== window.location.origin
  ) {
    throw new Error("Storage page origin does not match deployment config");
  }
  return { homeserver: `https://backend.${serverName}`, serverName };
}

/** Load the page-bound deployment identity before React starts. */
export async function loadRuntimeSettings(): Promise<RuntimeSettings> {
  if (isDevelopment()) {
    loadedSettings = developmentSettings();
    return loadedSettings;
  }
  let response: Response;
  try {
    response = await fetch(new URL(CONFIG_PATH, window.location.origin), {
      cache: "no-store",
      credentials: "same-origin",
    });
  } catch (error) {
    throw new Error("Storage deployment config could not be loaded", { cause: error });
  }
  if (!response.ok) throw new Error("Storage deployment config could not be loaded");
  let config: unknown;
  try {
    config = await response.json();
  } catch (error) {
    throw new Error("Storage deployment config is not valid JSON", { cause: error });
  }
  loadedSettings = settingsFromConfig(config);
  return loadedSettings;
}

export function getRuntimeSettings(): RuntimeSettings {
  if (isDevelopment()) return loadedSettings ?? developmentSettings();
  if (!loadedSettings) throw new Error("Storage deployment config has not been loaded");
  return loadedSettings;
}

export function runtimePublicAssetOrigin(): string {
  return `https://www.${getRuntimeSettings().serverName}`;
}

export function runtimeOidcIssuer(): string {
  return `${getRuntimeSettings().homeserver}/auth/`;
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
