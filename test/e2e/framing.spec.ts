import { execFileSync, spawn } from "node:child_process";
import type { BrowserContext } from "@playwright/test";
import { test, expect } from "./fixtures";

const DEV_ORIGIN = "http://localhost:5173";
const BUILT_PREVIEW_ORIGIN = "http://127.0.0.1:4173";
const BUILT_ORIGIN = "https://storage.framing.test";
const CROSS_ORIGIN_PARENT = "http://localhost:4174";
const NESTED_ORIGIN_PARENT = "http://127.0.0.1:4175";
const FRAME_MESSAGE = "418 I'm a teapot";
const SESSION_KEY = "telecrypt-io-ui:session";
const OIDC_INTENT_KEY = "telecrypt-io-ui:oidc-login-intent";
const PKCE_KEY = "mx_oidc_frame-guard";
const DATABASE_NAME = "telecrypt-frame-guard-test";
const DATABASE_STORE = "preserved-state";
const CALLBACK_QUERY = "?code=frame-code&state=frame-state";

const savedSession = {
  homeserver: "http://localhost:8008",
  userId: "@framed:localhost:8008",
  deviceId: "FRAMEDEVICE1",
  accessToken: "frame-access-token",
  refreshToken: "frame-refresh-token",
  oidcClientId: "frame-client-id",
};
const savedSessionJson = JSON.stringify(savedSession);
const savedIntentJson = JSON.stringify({ state: "frame-state" });
const savedPkceJson = JSON.stringify({ state: "frame-state", codeVerifier: "frame-verifier" });

interface StorageSnapshot {
  session: [string, string | null][];
  local: [string, string | null][];
}

interface PreviewServer {
  stop: () => Promise<void>;
}

function expectedStorage(): StorageSnapshot {
  return {
    session: [
      [PKCE_KEY, savedPkceJson],
      [OIDC_INTENT_KEY, savedIntentJson],
      [SESSION_KEY, savedSessionJson],
    ],
    local: [
      ["frame-guard-preserve", "kept"],
      ["frame-guard-seeded", "yes"],
      ["telecrypt-io-ui:oidc-client:http://localhost:8008/", "frame-client-id"],
    ],
  };
}

async function startBuiltPreview(): Promise<PreviewServer> {
  execFileSync("npm", ["run", "build:deployment"], {
    cwd: process.cwd(),
    env: { ...process.env, SERVER_NAME: "framing.test" },
    stdio: "pipe",
    timeout: 120_000,
  });

  const child = spawn(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "preview", "--host", "127.0.0.1", "--port", "4173", "--strictPort"],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  };

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Built Storage preview exited before becoming ready: ${output}`);
    }
    try {
      const response = await fetch(BUILT_PREVIEW_ORIGIN);
      if (response.ok) return { stop };
    } catch {
      // The preview server may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  await stop();
  throw new Error(`Built Storage preview did not become ready: ${output}`);
}

async function routeBuiltDeployment(context: BrowserContext): Promise<void> {
  await context.route(`${BUILT_ORIGIN}/**`, async (route) => {
    const requestUrl = new URL(route.request().url());
    const response = await route.fetch({
      url: `${BUILT_PREVIEW_ORIGIN}${requestUrl.pathname}${requestUrl.search}`,
    });
    await route.fulfill({ response });
  });
  await context.route("https://www.telecrypt.io/**", (route) => {
    if (route.request().url().endsWith(".css")) {
      return route.fulfill({ status: 200, contentType: "text/css", body: "" });
    }
    return route.fulfill({ status: 204, body: "" });
  });
}

async function installStorageSeeds(
  context: BrowserContext,
  origins: string[],
): Promise<void> {
  await context.addInitScript(
    ({ appOrigins, sessionKey, session, intentKey, intent, pkceKey, pkce, databaseName, storeName }) => {
      if (!appOrigins.includes(location.origin)) return;

      let openCount = 0;
      const nativeOpen = indexedDB.open.bind(indexedDB);
      Object.defineProperty(window, "__frameGuardIdbOpenCount", {
        configurable: true,
        get: () => openCount,
      });
      Object.defineProperty(indexedDB, "open", {
        configurable: true,
        value: (...args: Parameters<IDBFactory["open"]>) => {
          openCount += 1;
          return nativeOpen(...args);
        },
      });

      if (localStorage.getItem("frame-guard-seeded") === null) {
        sessionStorage.setItem(sessionKey, session);
        sessionStorage.setItem(intentKey, intent);
        sessionStorage.setItem(pkceKey, pkce);
        localStorage.setItem("frame-guard-seeded", "yes");
        localStorage.setItem("frame-guard-preserve", "kept");
        localStorage.setItem(
          "telecrypt-io-ui:oidc-client:http://localhost:8008/",
          "frame-client-id",
        );
      }

      const seeded = new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(databaseName, 1);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(storeName)) {
            request.result.createObjectStore(storeName);
          }
        };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          const transaction = database.transaction(storeName, "readwrite");
          transaction.objectStore(storeName).put("preserve", "marker");
          transaction.oncomplete = () => {
            database.close();
            resolve();
          };
          transaction.onerror = () => reject(transaction.error);
        };
      });
      Object.defineProperty(window, "__frameGuardSeedReady", {
        configurable: true,
        value: seeded,
      });
    },
    {
      appOrigins: origins,
      sessionKey: SESSION_KEY,
      session: savedSessionJson,
      intentKey: OIDC_INTENT_KEY,
      intent: savedIntentJson,
      pkceKey: PKCE_KEY,
      pkce: savedPkceJson,
      databaseName: DATABASE_NAME,
      storeName: DATABASE_STORE,
    },
  );
}

async function addFrameRoutes(
  context: BrowserContext,
  appOrigin: string,
): Promise<void> {
  const callback = `${appOrigin}/${CALLBACK_QUERY}`;
  await context.route(`${appOrigin}/__framing-parent.html`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><iframe id="storage" src="${callback}"></iframe>`,
    }),
  );
  await context.route(`${CROSS_ORIGIN_PARENT}/cross-origin.html`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><iframe id="storage" src="${callback}"></iframe>`,
    }),
  );
  await context.route(`${CROSS_ORIGIN_PARENT}/nested.html`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><iframe id="docs" src="${NESTED_ORIGIN_PARENT}/embed.html"></iframe>`,
    }),
  );
  await context.route(`${NESTED_ORIGIN_PARENT}/embed.html`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><iframe id="storage" src="${callback}"></iframe>`,
    }),
  );
}

test("direct Storage page still renders sign-in", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("oidc-login")).toBeVisible();
});

test("same-origin, cross-origin, and nested frames stop before Storage initializes", async ({
  context,
  page,
}) => {
  test.setTimeout(180_000);
  const preview = await startBuiltPreview();
  try {
    await routeBuiltDeployment(context);
    const builtConfigRequests: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/config.json") {
        builtConfigRequests.push(request.url());
      }
    });
    await page.goto(BUILT_ORIGIN);
    await expect(page.getByTestId("oidc-login")).toBeVisible();
    expect(builtConfigRequests).toEqual([`${BUILT_ORIGIN}/config.json`]);

    await installStorageSeeds(context, [DEV_ORIGIN, BUILT_ORIGIN]);
    await context.grantPermissions(["local-network-access"], { origin: CROSS_ORIGIN_PARENT });
    await context.grantPermissions(["local-network-access"], { origin: NESTED_ORIGIN_PARENT });
    const preserved = expectedStorage();
    const guardedRequests: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (
        url.pathname === "/config.json" ||
        url.hostname === "localhost" && url.port === "8008" ||
        /(?:^|\/)(?:\.well-known|_matrix|_mas|oauth2)(?:\/|$)|\.wasm$/iu.test(url.pathname)
      ) {
        guardedRequests.push(url.href);
      }
    });

    for (const appOrigin of [DEV_ORIGIN, BUILT_ORIGIN]) {
      await addFrameRoutes(context, appOrigin);
      const callback = `${appOrigin}/${CALLBACK_QUERY}`;
      const scenarios = [
        { url: `${appOrigin}/__framing-parent.html`, nested: false },
        { url: `${CROSS_ORIGIN_PARENT}/cross-origin.html`, nested: false },
        { url: `${CROSS_ORIGIN_PARENT}/nested.html`, nested: true },
      ];

      for (const scenario of scenarios) {
        await page.goto(scenario.url);
        const frame = scenario.nested
          ? page.frameLocator("#docs").frameLocator("#storage")
          : page.frameLocator("#storage");
        const root = frame.locator("#root");

        await expect(root.locator("h1")).toHaveText(FRAME_MESSAGE);
        await expect(frame.getByTestId("oidc-login")).toHaveCount(0);
        await expect(frame.getByTestId("vault-detail")).toHaveCount(0);

        const frameState = await root.evaluate(async (element) => {
          const entries = (storage: Storage): [string, string | null][] =>
            Array.from({ length: storage.length }, (_, index) => storage.key(index)!)
              .sort()
              .map((key) => [key, storage.getItem(key)]);
          const openCount = (window as Window & { __frameGuardIdbOpenCount?: number })
            .__frameGuardIdbOpenCount;
          await (window as Window & { __frameGuardSeedReady: Promise<void> }).__frameGuardSeedReady;
          const jsResources = performance.getEntriesByType("resource")
            .map((entry) => entry.name)
            .filter((name) => {
              const url = new URL(name);
              return url.origin === location.origin &&
                /\.(?:js|mjs|ts|tsx)$/iu.test(url.pathname) &&
                url.pathname !== "/@vite/client" &&
                url.pathname !== "/node_modules/vite/dist/client/env.mjs";
            });
          const database = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open("telecrypt-frame-guard-test", 1);
            request.onupgradeneeded = () => {
              request.transaction?.abort();
              reject(new Error("The seeded browser database was missing"));
            };
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
          });
          const marker = await new Promise<unknown>((resolve, reject) => {
            const request = database.transaction("preserved-state", "readonly")
              .objectStore("preserved-state").get("marker");
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          database.close();

          const heading = element.querySelector("h1");
          return {
            href: location.href,
            title: document.title,
            heading: heading?.textContent,
            foreground: heading ? getComputedStyle(heading).color : null,
            pageBackground: getComputedStyle(document.body).backgroundColor,
            session: entries(sessionStorage),
            local: entries(localStorage),
            indexedDbOpensBeforeTestRead: openCount,
            indexedDbMarker: marker,
            jsResources,
          };
        });

        expect(frameState).toMatchObject({
          href: callback,
          title: FRAME_MESSAGE,
          heading: FRAME_MESSAGE,
          foreground: "rgb(0, 0, 0)",
          pageBackground: "rgb(255, 255, 255)",
          session: preserved.session,
          local: preserved.local,
          indexedDbOpensBeforeTestRead: 1,
          indexedDbMarker: "preserve",
        });
        expect(frameState.jsResources).toHaveLength(1);
        expect(page.url()).toBe(scenario.url);
      }
    }

    expect(guardedRequests).toEqual([]);
  } finally {
    await preview.stop();
  }
});
