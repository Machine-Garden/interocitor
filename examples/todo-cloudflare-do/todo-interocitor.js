import { InterocitorRelayDurableObject, withInterocitor } from '../../packages/workers/dist/index.js';

const appWorker = {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/') {
      return new Response('todo app root\n', { status: 200 });
    }
    if (url.pathname === '/api/ping') {
      return Response.json({ ok: true, source: 'app' });
    }

    return new Response('App route not found\n', { status: 404 });
  },
};

export { InterocitorRelayDurableObject };

export default withInterocitor(appWorker, {
  mountPrefix: '/todo-interocitor',
  db: (env) => env.INTEROCITOR_DB,
  relay: (env) => env.INTEROCITOR_RELAY,
  runtime: {
    accessToken: (env) => env.INTEROCITOR_ACCESS_TOKEN,
    systemToken: (env) => env.INTEROCITOR_SYSTEM_TOKEN,
    meshSecret: (env) => env.INTEROCITOR_MESH_SECRET,
    verbose: (env) => env.INTEROCITOR_VERBOSE,
    enableScheduledMaintenance: (env) => env.INTEROCITOR_ENABLE_SCHEDULED_MAINTENANCE,
    pathTtlHours: (env) => env.INTEROCITOR_PATH_TTL_HOURS,
    maxControlBytes: (env) => env.INTEROCITOR_MAX_CONTROL_BYTES,
    maxChangeBytes: (env) => env.INTEROCITOR_MAX_CHANGE_BYTES,
    maxMainlineBytes: (env) => env.INTEROCITOR_MAX_MAINLINE_BYTES,
    maxGenericFileBytes: (env) => env.INTEROCITOR_MAX_GENERIC_FILE_BYTES,
  },
});
