/**
 * React bindings only. Engine lifecycle stays in app code:
 * construct engine → init → optional connect → provide. Pairing flows can
 * configure mesh state or attach remote storage before connecting.
 */
/**
 * `connect()` may return offline-ready if cloud setup stalls; hooks operate
 * against local state once the engine has initialized.
 */
export { createInterocitorContext } from "./context.ts";
export { useLiveQuery } from "./use-live-query.ts";
export type { UseLiveQueryResult } from "./use-live-query.ts";
export { useRow } from "./use-row.ts";
export type { UseRowResult } from "./use-row.ts";
export { useImage } from "./image.ts";
export type { UseImageResult } from "./image.ts";
export { useConnectedStores, useConnectedStore } from "./use-connected-stores.ts";
export type { UseConnectedStoresResult, UseConnectedStoreResult } from "./use-connected-stores.ts";
export { useConnectionStatus, useIsSolo } from "./use-connection-status.ts";
export type { ConnectionStatus, ConnectionStatusDetails } from "./use-connection-status.ts";
