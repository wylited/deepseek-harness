/**
 * restyle, node half. The empty apply gives Loader a host-side row while
 * the browser half ships through `exports["./client"]` (same split as
 * packages/client/ui-brand-official).
 */

/** Host plugin body — this package contributes browser presentation only. */
export function apply(): void {}
