import { Buffer } from 'node:buffer';
import { expect, test } from '@playwright/test';

import {
  CF_SYSTEM_BEARER_TOKEN,
  CF_TESTS_ENABLED,
  CF_WORKER_BASE_URL,
  meshBearerForNamespace,
  makeNamespace,
} from './playwright.helpers';

test.skip(!CF_TESTS_ENABLED, 'Cloudflare example e2e is opt-in; set RUN_CF_EXAMPLE_TESTS=1 to execute it.');

test.describe.configure({ mode: 'serial' });

function authHeaders(namespace: string): Record<string, string> {
  return {
    Authorization: `Bearer ${meshBearerForNamespace(namespace)}`,
  };
}

function fileUrl(namespace: string, path: string): string {
  return `${CF_WORKER_BASE_URL}/io/${encodeURIComponent(namespace)}/file?path=${encodeURIComponent(path)}`;
}

async function putFile(namespace: string, path: string, body: BodyInit): Promise<Response> {
  return await fetch(fileUrl(namespace, path), {
    method: 'PUT',
    headers: {
      ...authHeaders(namespace),
      'Content-Type': 'application/octet-stream',
    },
    body,
  });
}

async function getFile(namespace: string, path: string): Promise<Response> {
  return await fetch(fileUrl(namespace, path), {
    method: 'GET',
    headers: authHeaders(namespace),
  });
}

async function execute(namespace: string, payload: Record<string, unknown>): Promise<any> {
  const response = await fetch(`${CF_WORKER_BASE_URL}/__interocitor/system/${encodeURIComponent(namespace)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CF_SYSTEM_BEARER_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  expect(response.ok, `Expected execute op ${String(payload.op)} to succeed`).toBe(true);
  return await response.json();
}

test('Cloudflare worker tracks mesh-path activity and TTL maintenance deletes inactive paths', async () => {
  const namespace = makeNamespace();
  const remotePath = '/todo-app';
  const filePath = `${remotePath}/demo.txt`;
  const body = new TextEncoder().encode('hello maintenance');

  const putResponse = await putFile(namespace, filePath, body);
  expect(putResponse.status).toBe(201);

  let status = await execute(namespace, { op: 'maintenance-status', remotePath });
  expect(status.paths).toHaveLength(1);
  expect(status.paths[0].remote_root).toBe(remotePath);
  expect(Number(status.paths[0].current_file_count)).toBe(1);
  expect(Number(status.paths[0].current_total_bytes)).toBe(body.byteLength);
  expect(status.paths[0].last_write_at).toBeTruthy();
  expect(status.paths[0].deleted_at ?? null).toBeNull();

  const getResponse = await getFile(namespace, filePath);
  expect(getResponse.status).toBe(200);

  status = await execute(namespace, { op: 'maintenance-status', remotePath });
  expect(status.paths[0].last_read_at).toBeTruthy();
  expect(status.paths[0].last_operation_at).toBeTruthy();

  await new Promise((resolve) => {
    setTimeout(resolve, 25);
  });

  const maintenanceRun = await execute(namespace, { op: 'run-maintenance' });
  expect(Number(maintenanceRun.ttlCandidates)).toBeGreaterThanOrEqual(1);
  expect(Number(maintenanceRun.ttlDeleted)).toBe(1);

  const afterDelete = await getFile(namespace, filePath);
  expect(afterDelete.status).toBe(404);

  status = await execute(namespace, { op: 'maintenance-status', remotePath });
  expect(status.paths).toHaveLength(1);
  expect(status.paths[0].deleted_at).toBeTruthy();
  expect(Number(status.paths[0].current_file_count)).toBe(0);
  expect(Number(status.paths[0].current_total_bytes)).toBe(0);
});

test('Cloudflare worker rejects writes over the configured per-path size limit', async () => {
  const namespace = makeNamespace();
  const filePath = '/todo-app/changes/2026-04-07T00:00:00.000Z:000001:dev_x-chg_large.json';
  const oversized = Buffer.alloc(1_048_577, 0x61);

  const response = await putFile(namespace, filePath, oversized);
  expect(response.status).toBe(413);
  await expect(response.text()).resolves.toContain('Payload too large');

  const readBack = await getFile(namespace, filePath);
  expect(readBack.status).toBe(404);
});
