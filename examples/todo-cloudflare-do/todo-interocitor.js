import {
  checksummedMeshIntegrityGate,
  createMeshAuthorizationMiddleware,
  createInterocitorSystemHandler,
  InterocitorRelayDurableObject,
  R2FileBodyStore,
  withInterocitor,
} from "../../packages/workers/dist/index.js";

async function sha256Hex(value) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const meshBearerAuthorization = createMeshAuthorizationMiddleware(
  async ({ address, request }, env) => {
    const authorization = request.headers.get("Authorization") || "";
    const headerBearer = authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length).trim()
      : "";
    const bearer = headerBearer || new URL(request.url).searchParams.get("access_token") || "";
    const expected = await sha256Hex(`${address}${env.TODO_MESH_BEARER_SECRET || ""}`);
    return bearer && bearer === expected ? "full" : "deny";
  },
);

const interocitorOptions = {
  mountPrefix: "/todo-interocitor",
  db: (env) => env.INTEROCITOR_DB,
  files: (env) => new R2FileBodyStore(env.INTEROCITOR_FILES),
  relay: (env) => env.INTEROCITOR_RELAY,
  runtime: {
    meshIntegrityGates: [checksummedMeshIntegrityGate],
    meshMiddleware: [meshBearerAuthorization],
    meshSecret: (env) => env.INTEROCITOR_MESH_SECRET,
    verbose: (env) => env.INTEROCITOR_VERBOSE,
    enableScheduledMaintenance: (env) => env.INTEROCITOR_ENABLE_SCHEDULED_MAINTENANCE,
    pathTtlHours: (env) => env.INTEROCITOR_PATH_TTL_HOURS,
    maxControlBytes: (env) => env.INTEROCITOR_MAX_CONTROL_BYTES,
    maxChangeBytes: (env) => env.INTEROCITOR_MAX_CHANGE_BYTES,
    maxMainlineBytes: (env) => env.INTEROCITOR_MAX_MAINLINE_BYTES,
    maxGenericFileBytes: (env) => env.INTEROCITOR_MAX_GENERIC_FILE_BYTES,
    maxStoredFileBytes: (env) => env.INTEROCITOR_MAX_STORED_FILE_BYTES,
    maxMeshStoredBytes: (env) => env.INTEROCITOR_MAX_MESH_STORED_BYTES,
  },
};

const system = createInterocitorSystemHandler(interocitorOptions);

const appWorker = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (system.matches(url.pathname)) {
      if (request.headers.get("Authorization") !== `Bearer ${env.TODO_SYSTEM_BEARER_TOKEN}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      return system.fetch(request, env, ctx);
    }
    if (url.pathname === "/") return new Response("todo app root\n", { status: 200 });
    if (url.pathname === "/api/ping") return Response.json({ ok: true, source: "app" });
    return new Response("App route not found\n", { status: 404 });
  },
};

export { InterocitorRelayDurableObject };

export default withInterocitor(appWorker, interocitorOptions);
