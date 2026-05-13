// Imported (via side-effect) by every tests/web/*.test.ts file. Registers a
// happy-dom global environment so window / document / localStorage are
// available — but only inside web test files. The api tests use real fetch
// against a spawned broker and must NOT load happy-dom, because the
// registered global fetch enforces CORS and blocks cross-origin requests to
// 127.0.0.1.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as any).__pd_happydom_registered) {
  // Bun's native fetch (works against 127.0.0.1 with no CORS) must NOT be
  // replaced by happy-dom's fetch (which enforces CORS and breaks the API
  // tests when both suites run in the same process). Capture the native
  // before register() overwrites it, then restore.
  const nativeFetch = globalThis.fetch;
  GlobalRegistrator.register({ url: "http://localhost/" });
  globalThis.fetch = nativeFetch;
  // React 19 act() warns / silently drops effects unless this global is set
  // to mark the current environment as a test runner.
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as any).__pd_happydom_registered = true;
}
