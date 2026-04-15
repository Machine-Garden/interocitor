export { normalizePath, fileNameFromPath } from './ops.js';

export const PATH_TYPE = Object.freeze({
  MANIFEST_POINTER: 'manifest-pointer',
  MANIFEST_SNAPSHOT: 'manifest-snapshot',
  HEAD: 'head',
  CHANGE_FILE: 'change-file',
  MAINLINE_SNAPSHOT: 'mainline-snapshot',
  DEVICE_HEARTBEAT: 'device-heartbeat',
  OTHER: 'other',
});

export function classifyPath(path) {
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

export function parentPath(value) {
  if (value === '/') return null;
  const idx = value.lastIndexOf('/');
  return idx <= 0 ? '/' : value.slice(0, idx);
}

export function meshRootForPath(path, pathType = classifyPath(path)) {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  if (normalized === '/') return null;
  if (pathType === PATH_TYPE.MANIFEST_POINTER || pathType === PATH_TYPE.MANIFEST_SNAPSHOT) {
    return parentPath(normalized);
  }
  if ([PATH_TYPE.HEAD, PATH_TYPE.CHANGE_FILE, PATH_TYPE.MAINLINE_SNAPSHOT, PATH_TYPE.DEVICE_HEARTBEAT].includes(pathType)) {
    const parent = parentPath(normalized);
    return parent ? parentPath(parent) : null;
  }
  const seg = normalized.split('/').filter(Boolean)[0] ?? '';
  return seg ? `/${seg}` : null;
}

export function cacheKeyFor(prefix, path) {
  const safePrefix = encodeURIComponent(prefix);
  const safePath = path.startsWith('/') ? path : `/${path}`;
  return `https://interocitor-cache/${safePrefix}${safePath}`;
}
