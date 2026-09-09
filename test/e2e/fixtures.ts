import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  expect,
  test as base,
  type BrowserContext,
  type BrowserContextOptions,
  type TestInfo,
} from "@playwright/test";
import { formatDiagnosticError } from "../../src/lib/errorDetails";

type HoldFailedBrowser = (reason: string, options?: { teardown?: boolean }) => Promise<void>;

interface TrackedContext {
  context: BrowserContext;
  tracePath: string;
  traceAttempted: boolean;
}

interface BrowserContexts {
  create: () => Promise<BrowserContext>;
  stopTraces: (onError?: CleanupFailureHandler) => Promise<unknown[]>;
}

type CleanupFailureHandler = (error: unknown) => Promise<unknown[]>;

interface E2eTestFixtures {
  context: BrowserContext;
  contexts: BrowserContexts;
}

interface E2eWorkerFixtures {
  holdFailedBrowser: HoldFailedBrowser;
}

function requiredAbsoluteEnvironment(name: string): string {
  const value = process.env[name];
  if (!value || !path.isAbsolute(value) || value.includes("\0")) {
    throw new Error(`${name} must be an absolute path`);
  }
  return value;
}

async function loadHoldFailedBrowser(): Promise<HoldFailedBrowser> {
  const modulePath = requiredAbsoluteEnvironment("HARNESS_BROWSER_HOLD_MODULE");
  requiredAbsoluteEnvironment("HARNESS_BROWSER_HOLD_DIR");
  const loaded = await import(pathToFileURL(modulePath).href) as {
    holdFailedBrowser?: unknown;
  };
  if (typeof loaded.holdFailedBrowser !== "function") {
    throw new Error("HARNESS_BROWSER_HOLD_MODULE does not export holdFailedBrowser");
  }
  return loaded.holdFailedBrowser as HoldFailedBrowser;
}

function formatTestFailure(testInfo: TestInfo): string {
  return formatDiagnosticError({
    status: testInfo.status,
    expectedStatus: testInfo.expectedStatus,
    title: testInfo.title,
    errors: testInfo.errors,
  });
}

function combinedFailure(message: string, errors: unknown[]): Error {
  if (errors.length === 1 && errors[0] instanceof Error) return errors[0];
  const detail = errors.map((error) => formatDiagnosticError(error)).join("; ");
  return new AggregateError(errors, `${message}: ${detail}`, { cause: errors[0] });
}

export const test = base.extend<E2eTestFixtures, E2eWorkerFixtures>({
  // This worker fixture has no browser dependency, so the configured private Harness module is
  // loaded and validated before Playwright can create the worker browser.
  holdFailedBrowser: [async ({ browserName: _browserName }, provide) => {
    await provide(await loadHoldFailedBrowser());
  }, { scope: "worker", auto: true }],

  contexts: async ({ browser, baseURL, contextOptions, holdFailedBrowser }, provide, testInfo) => {
    const contexts: TrackedContext[] = [];

    const stopTraces = async (onError?: CleanupFailureHandler): Promise<unknown[]> => {
      const errors: unknown[] = [];
      for (const tracked of contexts) {
        if (tracked.traceAttempted) continue;
        tracked.traceAttempted = true;
        try {
          // Playwright's public instrumentation starts a trace chunk for every context created
          // while trace is on. Stop and immediately restart that chunk so the saved trace is
          // inspectable before a failure hold without breaking Playwright's later close handling.
          await tracked.context.tracing.stopChunk({ path: tracked.tracePath });
          await tracked.context.tracing.startChunk();
        } catch (error) {
          errors.push(error);
          if (onError) errors.push(...await onError(error));
          continue;
        }
        try {
          testInfo.attachments.push({
            name: path.basename(tracked.tracePath),
            path: tracked.tracePath,
            contentType: "application/zip",
          });
        } catch (error) {
          errors.push(error);
          if (onError) errors.push(...await onError(error));
        }
      }
      return errors;
    };

    const close = async (onError?: CleanupFailureHandler): Promise<unknown[]> => {
      const errors: unknown[] = [];
      for (const tracked of contexts) {
        try {
          await tracked.context.close();
        } catch (error) {
          errors.push(error);
          if (onError) errors.push(...await onError(error));
        }
      }
      return errors;
    };

    const browserContexts: BrowserContexts = {
      create: async () => {
        const tracePath = testInfo.outputPath(`context-${contexts.length}.zip`);
        const options: BrowserContextOptions = baseURL === undefined
          ? contextOptions
          : { ...contextOptions, baseURL };
        const context = await browser.newContext(options);
        const tracked: TrackedContext = {
          context,
          tracePath,
          traceAttempted: false,
        };
        contexts.push(tracked);
        return context;
      },
      stopTraces,
    };

    let useError: unknown;
    try {
      await provide(browserContexts);
    } catch (error) {
      useError = error;
    }

    const holdCleanupFailure = async (error: unknown): Promise<unknown[]> => {
      testInfo.setTimeout(0);
      try {
        await holdFailedBrowser(
          `storage_local_e2e_context_cleanup_failed\n${formatTestFailure(testInfo)}\n` +
          `cleanup error=${formatDiagnosticError(error)}`,
        );
        return [];
      } catch (error) {
        return [error];
      }
    };
    const cleanupErrors = await stopTraces(holdCleanupFailure);
    cleanupErrors.push(...await close(holdCleanupFailure));

    const failures = [
      ...(useError === undefined ? [] : [useError]),
      ...cleanupErrors,
    ];
    if (failures.length > 0) {
      if (testInfo.errors.length > 0 && testInfo.status !== testInfo.expectedStatus) {
        failures.unshift(new Error(formatTestFailure(testInfo)));
      }
      throw combinedFailure("Storage browser context lifecycle failed", failures);
    }
  },

  // Keep the primary Playwright context in the same registry as secondary contexts. The fixture
  // intentionally does not close it: registry teardown runs after afterEach, so the failure hold
  // sees every live browser context and every trace.
  context: async ({ contexts }, provide) => {
    await provide(await contexts.create());
  },
});

test.afterEach(async ({ holdFailedBrowser, contexts }, testInfo) => {
  // The contexts fixture retains errors from dependent fixtures and the test body so it can
  // preserve traces before closing browsers. During afterEach, Playwright can therefore expose
  // the primary error before updating status from the expected `passed` value.
  const wrappedFailurePending = testInfo.expectedStatus === "passed" && testInfo.errors.length > 0;
  if (testInfo.status === testInfo.expectedStatus && !wrappedFailurePending) return;

  testInfo.setTimeout(0);
  // Snapshot the complete primary failure before any trace finalization or hold operation.
  const failureDetail = formatTestFailure(testInfo);
  const traceErrors = await contexts.stopTraces();
  const failures = [...traceErrors];
  try {
    await holdFailedBrowser(
      `storage_local_e2e_test_failed\n${failureDetail}\n` +
      (traceErrors.length === 0
        ? "browser context traces finalized"
        : `browser context trace errors=${traceErrors.map((error) => formatDiagnosticError(error)).join("; ")}`),
    );
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    failures.unshift(new Error(failureDetail));
    throw combinedFailure("Storage local E2E failure preservation failed", failures);
  }
});

export { expect };
