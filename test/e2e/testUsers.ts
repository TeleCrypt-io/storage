/**
 * Creates throwaway accounts through MAS and confirms Synapse provisioning with
 * the same OIDC device-code grant used by the SDK and CLI. The web application
 * itself is still exercised separately through its browser authorization-code
 * flow in uiHelpers.ts.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { inspect, promisify } from "node:util";
import {
  discoverOidcIssuer,
  isDeviceAccessTokenError,
  registerClient,
  startDeviceCodeLogin,
  waitForDeviceCodeLogin,
  whoAmI,
} from "@telecrypt-io/storage/core";

const execFileAsync = promisify(execFile);
const HOMESERVER = "http://localhost:8008";
const SERVER_NAME = "localhost:8008";
const MAS_BASE = new URL(`${HOMESERVER}/`);
const PROVISIONING_RETRIES = 3;
const PROVISIONING_RETRY_DELAY_MS = 300;

export interface E2eUser {
  userId: string;
  localpart: string;
  password: string;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

function newDeviceId(): string {
  // MAS requires device IDs to use its restricted character set and contain
  // at least ten characters.
  return `WEB${randomBytes(8).toString("hex").toUpperCase()}`;
}

async function registerUserInMas(username: string, password: string): Promise<void> {
  const email = `${username}@example.com`;
  const diagnostic = (value: unknown): string => {
    let text = typeof value === "string" ? value : inspect(value, { depth: null, maxStringLength: null, maxArrayLength: null });
    for (const secret of [password, email, username]) {
      if (secret) text = text.split(secret).join("<redacted>");
    }
    return text;
  };
  const args = [
    "exec",
    "throwaway-mas",
    "mas-cli",
    "manage",
    "register-user",
    username,
    "--password",
    password,
    "--email",
    email,
    "--yes",
    "--ignore-password-complexity",
    "-c",
    "/data/config.yaml",
  ];

  // Immediately after the disposable stack starts, MAS can briefly fail to
  // resolve its Postgres hostname. Retry only that transient failure.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await execFileAsync("podman", args, { maxBuffer: Number.POSITIVE_INFINITY });
      process.stdout.write(diagnostic(result.stdout));
      process.stderr.write(diagnostic(result.stderr));
      return;
    } catch (err) {
      const e = err as { stdout?: unknown; stderr?: unknown };
      const output = [e.stderr, e.stdout].filter((value): value is string => typeof value === "string").join("\n");
      const detail = diagnostic(err);
      process.stderr.write(`${detail}\n`);
      if (!output.includes("Temporary failure in name resolution") || attempt === 3) {
        throw new Error(`mas-cli register-user failed: ${detail}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

/** Minimal temporary storage needed by SDK OIDC discovery under Node. */
class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

async function discoverOidc(): Promise<Awaited<ReturnType<typeof discoverOidcIssuer>>> {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: { localStorage: storage, sessionStorage: storage },
  });
  try {
    return await discoverOidcIssuer(HOMESERVER);
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, "window", descriptor);
    } else {
      delete (globalThis as { window?: unknown }).window;
    }
  }
}

function extractCsrf(html: string): string {
  for (const match of html.matchAll(/<input\b[^>]*>/gi)) {
    const input = match[0];
    const name = input.match(/\bname\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (name !== "csrf") continue;
    const value = input.match(/\bvalue\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (value) return value;
  }
  throw new Error("OIDC approval: no CSRF token on MAS page");
}

function extractFormAction(html: string, fallback: URL): string {
  const form = html.match(/<form\b[^>]*>/i)?.[0];
  if (!form) throw new Error("OIDC approval: no form on MAS page");
  const action = form.match(/\baction\s*=\s*(["'])(.*?)\1/i)?.[2];
  return new URL(action || fallback.toString(), fallback).toString();
}

function localMasUrl(location: string): URL {
  const url = new URL(location, MAS_BASE);
  if (url.origin !== MAS_BASE.origin || url.username || url.password) {
    throw new Error(`OIDC approval: refusing non-local MAS URL ${location}`);
  }
  if (!url.pathname.startsWith(MAS_BASE.pathname)) {
    throw new Error(`OIDC approval: refusing non-MAS URL ${location}`);
  }
  return url;
}

class CookieJar {
  private readonly cookies = new Map<string, string>();

  private update(response: Response): void {
    for (const cookie of response.headers.getSetCookie?.() ?? []) {
      const [pair] = cookie.split(";");
      const equals = pair.indexOf("=");
      if (equals <= 0) throw new Error("OIDC approval: malformed Set-Cookie header");
      this.cookies.set(pair.slice(0, equals), pair.slice(equals + 1));
    }
  }

  private header(): string {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  async get(location: string): Promise<Response> {
    const response = await fetch(localMasUrl(location), {
      headers: { Cookie: this.header() },
      redirect: "manual",
    });
    this.update(response);
    return response;
  }

  async post(location: string, fields: Record<string, string>): Promise<Response> {
    const response = await fetch(localMasUrl(location), {
      method: "POST",
      headers: {
        Cookie: this.header(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(fields).toString(),
      redirect: "manual",
    });
    this.update(response);
    return response;
  }

  async follow(response: Response): Promise<Response> {
    let current = response;
    for (let redirects = 0; redirects < 10; redirects++) {
      const location = current.headers.get("location");
      if (current.status < 300 || current.status >= 400 || !location) return current;
      current = await this.get(location);
    }
    throw new Error("OIDC approval: too many MAS redirects");
  }
}

/**
 * Approves a device grant through MAS's real login, device-link, and consent
 * forms. This is test infrastructure only; the password is sent to MAS's
 * OIDC page, never to a Matrix login endpoint or to the Storage application.
 */
async function approveDeviceCode(username: string, password: string, userCode: string): Promise<void> {
  const jar = new CookieJar();
  const loginUrl = new URL("login", MAS_BASE);

  let response = await jar.get(loginUrl.toString());
  let csrf = extractCsrf(await response.text());
  response = await jar.post(loginUrl.toString(), { csrf, username, password });
  if (response.status !== 303) {
    throw new Error(`OIDC approval: login did not redirect (${response.status})`);
  }
  await jar.follow(response);

  const linkUrl = new URL("link", MAS_BASE);
  response = await jar.get(linkUrl.toString());
  const linkHtml = await response.text();
  if (response.status !== 200) {
    throw new Error(`OIDC approval: device-link form failed (${response.status})`);
  }
  csrf = extractCsrf(linkHtml);
  const linkAction = extractFormAction(linkHtml, linkUrl);
  response = await jar.post(linkAction, { csrf, code: userCode });
  const devicePath = response.headers.get("location");
  if (response.status !== 303 || !devicePath) {
    throw new Error(`OIDC approval: device-link submission failed (${response.status})`);
  }
  response = await jar.follow(response);

  if (response.status !== 200) {
    throw new Error(`OIDC approval: consent form failed (${response.status})`);
  }
  csrf = extractCsrf(await response.text());
  response = await jar.post(devicePath, { csrf, confirm_device: "on", action: "consent" });
  if (response.status !== 200) {
    throw new Error(`OIDC approval: consent failed (${response.status})`);
  }
}

interface DeviceLogin {
  userId: string;
}

function isProvisioningRace(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:failed to provision(?: device)?|user not found|failed to create device)/i.test(message);
}

async function loginViaDeviceCode(
  username: string,
  password: string,
  deviceId: string,
): Promise<DeviceLogin> {
  const authMetadata = await discoverOidc();
  const clientId = await registerClient(authMetadata, {
    clientName: "TeleCrypt.io Storage Web disposable test",
    clientUri: "http://localhost:1234/",
    applicationType: "native",
    redirectUris: ["http://localhost:1234/callback"],
    contacts: undefined,
    tosUri: undefined,
    policyUri: undefined,
  });
  const session = await startDeviceCodeLogin(authMetadata, clientId, deviceId);
  const [result] = await Promise.all([
    waitForDeviceCodeLogin(authMetadata, clientId, session),
    approveDeviceCode(username, password, session.user_code),
  ]);
  if (isDeviceAccessTokenError(result)) {
    throw new Error(`device-code login failed (${result.error}): ${result.error_description ?? "no description"}`);
  }
  const identity = await whoAmI(HOMESERVER, result.access_token, SERVER_NAME);
  if (identity.deviceId !== deviceId) {
    throw new Error(
      `device-code login returned device ${identity.deviceId ?? "none"}, expected ${deviceId}`,
    );
  }
  return { userId: identity.userId };
}

/**
 * MAS creates the Matrix-side account asynchronously. Retry the complete
 * device-code grant only for that specific provisioning race; authentication,
 * approval, and token errors fail immediately.
 */
async function waitForSynapseProvisioning(
  username: string,
  password: string,
  deviceId: string,
): Promise<DeviceLogin> {
  for (let attempt = 1; attempt <= PROVISIONING_RETRIES; attempt++) {
    try {
      return await loginViaDeviceCode(username, password, deviceId);
    } catch (error) {
      if (!isProvisioningRace(error) || attempt === PROVISIONING_RETRIES) throw error;
      await new Promise((resolve) => setTimeout(resolve, PROVISIONING_RETRY_DELAY_MS));
    }
  }
  throw new Error("device-code provisioning retry exhausted");
}

export async function registerE2eUser(prefix: string): Promise<E2eUser> {
  const suffix = randomSuffix();
  // MAS requires a lowercase Matrix localpart.
  const localpart = `${prefix}_${suffix}`.toLowerCase();
  const password = `pwd_${suffix}`;

  await registerUserInMas(localpart, password);
  const data = await waitForSynapseProvisioning(localpart, password, newDeviceId());
  return { userId: data.userId, localpart, password };
}

/** Polls the server-side key-backup endpoint until it reports at least
 * `minCount` stored keys, proving that the background upload finished. It needs
 * a device access token, which the UI
 * doesn't expose in the DOM, so the caller passes the OIDC access token held
 * in its own test session. */
export async function waitForServerBackupCount(
  accessToken: string,
  minCount: number,
  timeoutMs = 20000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch("http://localhost:8008/_matrix/client/v3/room_keys/version", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.ok) {
      const info = (await res.json()) as { count?: number };
      if ((info.count ?? 0) >= minCount) return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for server backup count >= ${minCount}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
