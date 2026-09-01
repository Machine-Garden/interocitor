#!/usr/bin/env node

/**
 * local-webdav-server.mjs
 *
 * Single-port dev server serving two concerns:
 *   1. Static files  — any URL not starting with /__webdav__
 *   2. WebDAV store  — URLs under /__webdav__
 *
 * ─── Request routing ──────────────────────────────────────────────────────────
 *
 * ```mermaid
 * flowchart TD
 *     REQ[HTTP Request] --> ROUTE{URL starts with\n/__webdav__?}
 *     ROUTE -- Yes --> DAV[handleWebDav]
 *     ROUTE -- No  --> STATIC[serve file from project root]
 *     STATIC -- not found --> M404[404 Not Found]
 *
 *     DAV --> PARSE["parseDavPath(url)\nstrip /__webdav__ prefix\nURL-decode segments"]
 *     PARSE --> METHOD{HTTP method}
 *     METHOD -- OPTIONS  --> OPT[200 + Allow + DAV headers]
 *     METHOD -- PROPFIND --> PF{Depth header}
 *     PF -- 0 single resource --> META[file or folder metadata]
 *     PF -- 1 folder listing  --> LIST[folder node + direct children\nfiles via listFiles\nsubfolders via listFolders]
 *     METHOD -- MKCOL  --> MKDIR[ensureFolder — idempotent\nreturns 201 if already exists]
 *     METHOD -- PUT    --> PUT[readRequestBody → putFile]
 *     METHOD -- GET    --> GET[getFile → stream bytes]
 *     METHOD -- DELETE --> DEL[deleteFile — recursive for collections]
 *     METHOD -- other  --> M405[405 Method Not Allowed]
 * ```
 *
 * ─── Backend seam ─────────────────────────────────────────────────────────────
 *
 * Storage is injected at startup via --mode CLI flag.
 * Both backends expose the identical async API:
 *   hasFolder / listFiles / listFolders / getFile / putFile / deleteFile / ensureFolder
 *
 * ```mermaid
 * flowchart LR
 *     CLI1["--mode=memory\n(default, used by test:e2e:server)"] --> MEM
 *     CLI2["--mode=file --data-root=PATH\n(used by demo:todo:server)"] --> FILE
 *
 *     MEM["makeMemoryBackend()\nMap&lt;path,file&gt; + Set&lt;folder&gt;\nno persistence — wiped on restart"]
 *     FILE["makeFileBackend(rootDir)\nreal fs under examples/.../webdav-data/\npersists between demo sessions"]
 *
 *     MEM --> API[[Backend API]]
 *     FILE --> API
 * ```
 *
 * ─── Test harness vs real server ──────────────────────────────────────────────
 *
 * ```mermaid
 * flowchart TD
 *     SPEC[e2e spec file] --> WHICH{which HTML fixture?}
 *
 *     WHICH -- "harness.html\n(most specs)" --> MOCK["window.__webdavMock\npatches fetch in-browser\nroutes /__webdav__ to JS MemoryAdapter\nNEVER reaches this server"]
 *     WHICH -- "examples/todo-webdav/index.html\n(todo-webdav.spec.ts)" --> REAL["real HTTP to this server\n/__webdav__ handled by makeMemoryBackend()\nstate shared across all pages in the test run"]
 * ```
 *
 */

import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { extname, join, normalize, dirname, resolve } from "node:path";

const PORT = Number(process.env.PORT || "4173");
const ROOT = process.env.INTEROCITOR_REPO_ROOT || resolve(import.meta.dirname, "../..");
const WEBDAV_PREFIX = "/__webdav__";

function parseArgs(argv) {
  const options = {
    mode: null,
    dataRoot: null,
  };

  for (const arg of argv) {
    if (arg.startsWith("--mode=")) {
      options.mode = arg.slice("--mode=".length);
    }
    if (arg.startsWith("--data-root=")) {
      options.dataRoot = arg.slice("--data-root=".length);
    }
  }

  return options;
}

function resolveOptions(parsed) {
  const mode = parsed.mode || (parsed.dataRoot ? "file" : "memory");

  if (mode !== "memory" && mode !== "file") {
    throw new Error(`Unsupported --mode value: ${mode}`);
  }

  if (mode === "file" && !parsed.dataRoot) {
    throw new Error("Missing --data-root for file mode");
  }

  return {
    mode,
    dataRoot: parsed.dataRoot,
  };
}

const options = resolveOptions(parseArgs(process.argv.slice(2)));

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".ts": "application/typescript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

function nowIso() {
  return new Date().toISOString();
}

function toHttpDate(iso) {
  return new Date(iso).toUTCString();
}

function encodePath(path) {
  return path
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function parseDavPath(urlPath) {
  const pathname = new URL(urlPath, `http://127.0.0.1:${PORT}`).pathname;
  if (!pathname.startsWith(WEBDAV_PREFIX)) {
    return null;
  }

  const raw = pathname.slice(WEBDAV_PREFIX.length) || "/";
  const normalized = `/${raw}`.replaceAll(/\/+/g, "/");
  const clean =
    normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
  return decodeURIComponent(clean);
}

function makePropfindResponse(entries) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<d:multistatus xmlns:d="DAV:">\n${entries.join("\n")}\n</d:multistatus>`;
}

function makeResponseNode({ href, size, modifiedIso, etag, isCollection }) {
  const resourceType = isCollection ? "<d:collection/>" : "";
  const contentLength = isCollection ? "" : `<d:getcontentlength>${size}</d:getcontentlength>`;
  return `<d:response>
  <d:href>${escapeXml(href)}</d:href>
  <d:propstat>
    <d:prop>
      ${contentLength}
      <d:getlastmodified>${escapeXml(toHttpDate(modifiedIso))}</d:getlastmodified>
      <d:resourcetype>${resourceType}</d:resourcetype>
      <d:getetag>${escapeXml(etag || "")}</d:getetag>
    </d:prop>
    <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
</d:response>`;
}

function makeMemoryBackend() {
  const files = new Map();
  const folders = new Set(["/"]);

  return {
    async hasFolder(path) {
      return folders.has(path);
    },
    async listFiles(path) {
      const result = [];
      for (const [filePath, file] of files) {
        if (!filePath.startsWith(`${path}/`)) continue;
        const remainder = filePath.slice(path.length + 1);
        if (remainder.includes("/")) continue;
        result.push({ path: filePath, file });
      }
      return result;
    },
    async listFolders(path) {
      const result = [];
      for (const folder of folders) {
        if (!folder.startsWith(`${path}/`)) continue;
        const remainder = folder.slice(path.length + 1);
        if (!remainder || remainder.includes("/")) continue;
        result.push(folder);
      }
      return result;
    },
    async getFile(path) {
      return files.get(path) || null;
    },
    async putFile(path, bytes) {
      const existed = files.has(path);
      files.set(path, {
        data: bytes,
        modifiedTime: nowIso(),
        etag: `"etag-${Math.random().toString(16).slice(2)}"`,
      });
      return existed;
    },
    async deleteFile(path) {
      if (files.delete(path)) return true;
      // Collection (folder) deletion — recursive
      if (folders.has(path)) {
        for (const filePath of files.keys()) {
          if (filePath.startsWith(`${path}/`)) files.delete(filePath);
        }
        for (const folder of folders) {
          if (folder.startsWith(`${path}/`)) folders.delete(folder);
        }
        folders.delete(path);
        return true;
      }
      return false;
    },
    async ensureFolder(path) {
      // Return 201 (not 405) for already-existing folders: idempotent create,
      // same as S3/Azure semantics. Avoids noisy browser console errors when
      // a second device connects and tries to create folders the first already made.
      if (folders.has(path)) return { status: 201 };
      const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) || "/" : "/";
      if (!folders.has(parent)) return { status: 409 };
      folders.add(path);
      return { status: 201 };
    },
  };
}

function makeFileBackend(rootDir) {
  const dataRoot = join(ROOT, rootDir);

  function cleanDavPath(path) {
    const normalized = normalize(path).replaceAll("\\", "/");
    const withSlash = normalized.startsWith("/") ? normalized : `/${normalized}`;
    if (withSlash.includes("..")) return null;
    return withSlash;
  }

  function fsPath(davPath) {
    const clean = cleanDavPath(davPath);
    if (!clean) return null;
    const relative = clean.replace(/^\//, "");
    return join(dataRoot, relative);
  }

  async function fileMeta(absolutePath) {
    const fileStat = await stat(absolutePath);
    return {
      data: await readFile(absolutePath),
      modifiedTime: fileStat.mtime.toISOString(),
      etag: `"etag-${fileStat.mtimeMs}-${fileStat.size}"`,
    };
  }

  return {
    async hasFolder(path) {
      if (path === "/") return true;
      const absolute = fsPath(path);
      if (!absolute) return false;
      try {
        return (await stat(absolute)).isDirectory();
      } catch {
        return false;
      }
    },
    async listFiles(path) {
      const absolute = path === "/" ? dataRoot : fsPath(path);
      if (!absolute) return [];
      try {
        const children = await readdir(absolute, { withFileTypes: true });
        const result = [];
        for (const child of children) {
          if (!child.isFile()) continue;
          const childDavPath = path === "/" ? `/${child.name}` : `${path}/${child.name}`;
          const absoluteChild = join(absolute, child.name);
          result.push({ path: childDavPath, file: await fileMeta(absoluteChild) });
        }
        return result;
      } catch {
        return [];
      }
    },
    async listFolders(path) {
      const absolute = path === "/" ? dataRoot : fsPath(path);
      if (!absolute) return [];
      try {
        const children = await readdir(absolute, { withFileTypes: true });
        return children
          .filter((child) => child.isDirectory())
          .map((child) => (path === "/" ? `/${child.name}` : `${path}/${child.name}`));
      } catch {
        return [];
      }
    },
    async getFile(path) {
      const absolute = fsPath(path);
      if (!absolute) return null;
      try {
        return await fileMeta(absolute);
      } catch {
        return null;
      }
    },
    async putFile(path, bytes) {
      const absolute = fsPath(path);
      if (!absolute) return false;

      let existed = false;
      try {
        existed = (await stat(absolute)).isFile();
      } catch {
        existed = false;
      }

      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, bytes);
      return existed;
    },
    async deleteFile(path) {
      const absolute = fsPath(path);
      if (!absolute) return false;
      try {
        const s = await stat(absolute);
        if (s.isDirectory()) {
          // Recursive collection delete
          await rm(absolute, { recursive: true });
          return true;
        }
        await unlink(absolute);
        return true;
      } catch {
        return false;
      }
    },
    async ensureFolder(path) {
      if (path === "/") {
        await mkdir(dataRoot, { recursive: true });
        // Idempotent root ensure — return 201, not 405.
        return { status: 201 };
      }

      const absolute = fsPath(path);
      if (!absolute) return { status: 409 };

      try {
        if ((await stat(absolute)).isDirectory()) {
          // Idempotent: folder already exists — return 201, not 405.
          // Avoids browser console errors when multiple devices connect.
          return { status: 201 };
        }
      } catch {
        // continue
      }

      const parent = dirname(absolute);
      try {
        if (!(await stat(parent)).isDirectory()) {
          return { status: 409 };
        }
      } catch {
        return { status: 409 };
      }

      await mkdir(absolute, { recursive: false });
      return { status: 201 };
    },
    async init() {
      await rm(dataRoot, { recursive: true, force: false }).catch(() => {});
      await mkdir(dataRoot, { recursive: true });
    },
    dataRoot,
  };
}

const webDavBackend =
  options.mode === "file" ? makeFileBackend(options.dataRoot) : makeMemoryBackend();
if (webDavBackend.init) {
  await webDavBackend.init();
}

function readRequestBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", rejectBody);
  });
}

async function handleWebDav(req, res) {
  const method = (req.method || "GET").toUpperCase();
  const path = parseDavPath(req.url || "/");
  if (!path) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  if (method === "OPTIONS") {
    res.writeHead(200, {
      Allow: "OPTIONS, PROPFIND, MKCOL, PUT, GET, DELETE",
      DAV: "1",
    });
    res.end("");
    return;
  }

  if (method === "PROPFIND") {
    const depth = req.headers.depth || "0";

    if (depth === "0") {
      if (await webDavBackend.hasFolder(path)) {
        const href = `${WEBDAV_PREFIX}/${encodePath(path)}/`;
        const body = makePropfindResponse([
          makeResponseNode({ href, size: 0, modifiedIso: nowIso(), etag: "", isCollection: true }),
        ]);
        res.writeHead(207, { "Content-Type": "application/xml; charset=utf-8" });
        res.end(body);
        return;
      }

      const file = await webDavBackend.getFile(path);
      if (!file) {
        res.writeHead(404);
        res.end("");
        return;
      }

      const href = `${WEBDAV_PREFIX}/${encodePath(path)}`;
      const body = makePropfindResponse([
        makeResponseNode({
          href,
          size: file.data.length,
          modifiedIso: file.modifiedTime,
          etag: file.etag,
          isCollection: false,
        }),
      ]);
      res.writeHead(207, { "Content-Type": "application/xml; charset=utf-8" });
      res.end(body);
      return;
    }

    if (!(await webDavBackend.hasFolder(path))) {
      res.writeHead(404);
      res.end("");
      return;
    }

    const nodes = [
      makeResponseNode({
        href: `${WEBDAV_PREFIX}/${encodePath(path)}/`,
        size: 0,
        modifiedIso: nowIso(),
        etag: "",
        isCollection: true,
      }),
    ];

    for (const { path: filePath, file } of await webDavBackend.listFiles(path)) {
      nodes.push(
        makeResponseNode({
          href: `${WEBDAV_PREFIX}/${encodePath(filePath)}`,
          size: file.data.length,
          modifiedIso: file.modifiedTime,
          etag: file.etag,
          isCollection: false,
        }),
      );
    }

    for (const folder of await webDavBackend.listFolders(path)) {
      nodes.push(
        makeResponseNode({
          href: `${WEBDAV_PREFIX}/${encodePath(folder)}/`,
          size: 0,
          modifiedIso: nowIso(),
          etag: "",
          isCollection: true,
        }),
      );
    }

    res.writeHead(207, { "Content-Type": "application/xml; charset=utf-8" });
    res.end(makePropfindResponse(nodes));
    return;
  }

  if (method === "MKCOL") {
    const result = await webDavBackend.ensureFolder(path);
    res.writeHead(result.status);
    res.end("");
    return;
  }

  if (method === "PUT") {
    const body = await readRequestBody(req);
    const existed = await webDavBackend.putFile(path, body);
    res.writeHead(existed ? 204 : 201);
    res.end("");
    return;
  }

  if (method === "GET") {
    const file = await webDavBackend.getFile(path);
    if (!file) {
      res.writeHead(404);
      res.end("");
      return;
    }

    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    res.end(Buffer.from(file.data));
    return;
  }

  if (method === "DELETE") {
    const existed = await webDavBackend.deleteFile(path);
    res.writeHead(existed ? 204 : 404);
    res.end("");
    return;
  }

  res.writeHead(405);
  res.end("Method not allowed");
}

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const clean = decoded === "/" ? "/examples/index.html" : decoded;
  const normalized = normalize(clean).replace(/^\/+/, "");
  if (normalized.includes("..")) return null;
  return join(ROOT, normalized);
}

const server = createServer(async (req, res) => {
  if ((req.url || "").startsWith(WEBDAV_PREFIX)) {
    await handleWebDav(req, res);
    return;
  }

  const absolutePath = safePath(req.url || "/");
  if (!absolutePath) {
    res.writeHead(400);
    res.end("Bad request");
    return;
  }

  try {
    const fileStat = await stat(absolutePath);
    if (fileStat.isDirectory()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = extname(absolutePath);
    const contentType = contentTypes[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    createReadStream(absolutePath).pipe(res);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  const modeText = options.mode === "file" ? `file (${join(ROOT, options.dataRoot)})` : "memory";
  process.stdout.write(
    `local webdav server listening on http://127.0.0.1:${PORT} [mode=${modeText}]\n`,
  );
});
