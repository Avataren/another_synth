/**
 * Test stub for Quasar's `#q-app/wrappers` module (not resolvable under
 * vitest's alias set). `defineBoot` is a typing wrapper in Quasar: it
 * returns the boot function unchanged, so tests can invoke a boot module's
 * default export directly.
 */
export function defineBoot<T>(fn: T): T {
  return fn;
}

export function definePreload<T>(fn: T): T {
  return fn;
}