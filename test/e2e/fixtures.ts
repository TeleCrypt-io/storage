import path from "node:path";
import {
  expect,
  test as base,
  type BrowserContext,
  type BrowserContextOptions,
  type TestInfo,
} from "@playwright/test";
import { formatDiagnosticError } from "../../src/lib/errorDetails";

interface TrackedContext {
  context: BrowserContext;
  tracePath: string;
  traceAttempted: boolean;
}

interface BrowserContexts {
  create: () => Promise<BrowserContext>;
  stopTraces: () => Promise<unknown[]>;
}

interface E2eTestFixtures {
  context: BrowserContext;
  contexts: BrowserContexts;
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

export const test = base.extend<E2eTestFixtures>({
  contexts: async ({ browser, baseURL, contextOptions }, provide, testInfo) => {
    const contexts: TrackedContext[] = [];

    const stopTraces = async (): Promise<unknown[]> => {
      const errors: unknown[] = [];
      for (const tracked of contexts) {
        if (tracked.traceAttempted) continue;
        tracked.traceAttempted = true;
        try {
          // Playwright's public instrumentation starts a trace chunk for every context created
          // while trace is on. Stop and immediately restart that chunk so the saved trace is
          // inspectable before context close without breaking Playwright's later close handling.
          await tracked.context.tracing.stopChunk({ path: tracked.tracePath });
          await tracked.context.tracing.startChunk();
        } catch (error) {
          errors.push(error);
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
        }
      }
      return errors;
    };

    const close = async (): Promise<unknown[]> => {
      const errors: unknown[] = [];
      for (const tracked of contexts) {
        try {
          await tracked.context.close();
        } catch (error) {
          errors.push(error);
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

    const cleanupErrors = await stopTraces();
    cleanupErrors.push(...await close());

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
  // intentionally does not close it here: registry teardown closes every tracked context.
  context: async ({ contexts }, provide) => {
    await provide(await contexts.create());
  },
});

export { expect };
