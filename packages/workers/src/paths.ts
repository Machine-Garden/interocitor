export { normalizePath, fileNameFromPath } from './ops.ts';

/**
 * All recognised Interocitor path types.
 *
 * - `manifest-pointer` — `manifest.json` at a remote root (mutable, semantic merge)
 * - `manifest-snapshot` — `manifest-<gen>.json` (immutable, cached forever)
 * - `head` — `changes/head.json` (mutable, HLC-ordered merge)
 * - `change-file` — `changes/<hlc>-chg_<id>.json` (immutable, cached forever)
 * - `mainline-snapshot` — `mainline/<name>` (immutable, cached forever)
 * - `device-heartbeat` — `devices/<id>` (mutable, always overwrite)
 * - `other` — anything not matched above (generic overwrite semantics)
 */
export const PATH_TYPE = Object.freeze({
  MANIFEST_POINTER: 'manifest-pointer',
  MANIFEST_SNAPSHOT: 'manifest-snapshot',
  HEAD: 'head',
  CHANGE_FILE: 'change-file',
  MAINLINE_SNAPSHOT: 'mainline-snapshot',
  DEVICE_HEARTBEAT: 'device-heartbeat',
  OTHER: 'other',
} as const);

/** Union of all valid path type strings. */
export type PathType = (typeof PATH_TYPE)[keyof typeof PATH_TYPE];

const MESH_CHILD_TYPES: PathType[] = [
  PATH_TYPE.HEAD,
  PATH_TYPE.CHANGE_FILE,
  PATH_TYPE.MAINLINE_SNAPSHOT,
  PATH_TYPE.DEVICE_HEARTBEAT,
];

/**
 * Classify an Interocitor path by its structural role.
 *
 * @param path - Absolute path string (leading `/` optional).
 * @returns The matching {@link PathType}.
 */
export function classifyPath(path: string): PathType {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  const name = normalized.slice(normalized.lastIndexOf('/') + 1);
  const parent = normalized.slice(0, normalized.lastIndexOf('/')) || '/';
  const parentName = parent.slice(parent.lastIndexOf('/') + 1);

  if (name === 'manifest.json') return PATH_TYPE.MANIFEST_POINTER;
  if (/^manifest-\d+\.json$/.test(name)) return PATH_TYPE.MANIFEST_SNAPSHOT;
  if (name === 'head.json' && parentName === 'changes') return PATH_TYPE.HEAD;
  if (/^.+-chg_.+\.json$/.test(name) && parentName === 'changes') return PATH_TYPE.CHANGE_FILE;
  if (parentName === 'mainline') return PATH_TYPE.MAINLINE_SNAPSHOT;
  if (parentName === 'devices') return PATH_TYPE.DEVICE_HEARTBEAT;
  return PATH_TYPE.OTHER;
}

/**
 * Return the parent path segment, or `null` if already at the root.
 *
 * @param value - Normalised absolute path.
 */
export function parentPath(value: string): string | null {
  if (value === '/') return null;
  const idx = value.lastIndexOf('/');
  return idx <= 0 ? '/' : value.slice(0, idx);
}

/**
 * Derive the mesh root for a path.
 *
 * The mesh root is the top-level directory that owns the mesh entry in
 * `mesh_paths`. Returns `null` for the file-system root (`'/'`).
 *
 * @param path - Absolute path to inspect.
 * @param pathType - Pre-computed type; if omitted it is computed from `path`.
 */
export function meshRootForPath(path: string, pathType: PathType = classifyPath(path)): string | null {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  if (normalized === '/') return null;
  if (pathType === PATH_TYPE.MANIFEST_POINTER || pathType === PATH_TYPE.MANIFEST_SNAPSHOT) {
    return parentPath(normalized);
  }
  if (MESH_CHILD_TYPES.includes(pathType)) {
    const parent = parentPath(normalized);
    return parent ? parentPath(parent) : null;
  }
  const seg = normalized.split('/').filter(Boolean)[0] ?? '';
  return seg ? `/${seg}` : null;
}

/**
 * Build the URL used as a key when storing a file in the Cache API.
 *
 * Keys are unique per `(prefix, path)` pair and are safe for use as URLs.
 *
 * @param prefix - Interocitor mount prefix (namespace).
 * @param path - Absolute file path.
 */
export function cacheKeyFor(prefix: string, path: string): string {
  const safePrefix = encodeURIComponent(prefix);
  const safePath = path.startsWith('/') ? path : `/${path}`;
  return `https://interocitor-cache/${safePrefix}${safePath}`;
}

/**
 * Build the URL used as a cache key for folder listings.
 *
 * Separate namespace from {@link cacheKeyFor} so file content and listing
 * caches cannot collide.
 */
export function listingCacheKeyFor(prefix: string, path: string): string {
  const safePrefix = encodeURIComponent(prefix);
  const safePath = path.startsWith('/') ? path : `/${path}`;
  return `https://interocitor-cache/listings/${safePrefix}${safePath}`;
}
