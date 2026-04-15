import { withInterocitor } from '../../packages/interocitor-workers/src/index.js';

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

export default withInterocitor('/todo-interocitor', appWorker);
