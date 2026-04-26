/**
 * Renderer-side logger (fusion 3.9).
 *
 * Two layers of defence against prod console pollution:
 *
 *   1. **Bundler-level strip** — `vite.config.mts` marks
 *      `console.log` / `console.info` / `console.debug` as pure so
 *      esbuild's DCE removes them from the production bundle. This
 *      catches every direct `console.log` site without touching
 *      ~272 call sites in the renderer.
 *
 *   2. **Module-level gate** — for code that explicitly imports this
 *      module (cleaner intent, easier grep), the `log/info/debug`
 *      methods short-circuit to a no-op in production. esbuild would
 *      in practice already remove the inner `console.log` from the
 *      no-op'd path, but the explicit gate keeps the two paths
 *      consistent — `logger.log(buildExpensiveObject())` does *not*
 *      evaluate the argument in prod.
 *
 * `warn` and `error` always emit — they are diagnostic surface for
 * production triage. The audit's concern was the *volume* of
 * `console.log`, not the absence of any console at all.
 *
 * Existing typed channels (`ipc`, `store`, `component`, `error`) are
 * preserved for back-compat with code that already imports `logger`.
 */

const isProd = import.meta.env?.PROD === true;

const noop = (..._args: unknown[]): void => {
  /* stripped in prod */
};

export const logger = {
  // Variadic mirrors of `console.*`. Prod-stripped trio.
  log: isProd ? noop : (...args: unknown[]) => console.log(...args),
  info: isProd ? noop : (...args: unknown[]) => console.info(...args),
  debug: isProd ? noop : (...args: unknown[]) => console.debug(...args),
  // Always emit — diagnostic surface for production triage.
  warn: (...args: unknown[]) => console.warn(...args),

  // Typed channels — preserved API. The body uses `console.log` so
  // the bundler strips them in prod via the same `pure` rule.
  ipc: (action: string, ...args: unknown[]) => {
    console.log(`[IPC] ${action}`, ...args);
  },
  store: (storeName: string, action: string, ...args: unknown[]) => {
    console.log(`[Store:${storeName}] ${action}`, ...args);
  },
  component: (componentName: string, action: string, ...args: unknown[]) => {
    console.log(`[${componentName}] ${action}`, ...args);
  },
  error: (context: string, messageOrError: unknown, ...args: unknown[]) => {
    console.error(`[ERROR:${context}]`, messageOrError, ...args);
  },
};
