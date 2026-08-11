import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createMockConsoleServer } from '../apps/mock-sangfor-console/src/server.js';

describe('mock console browser write/read-back seam', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => error ? reject(error) : resolve());
    });
    server = undefined;
  });

  it('persists and restores a configuration name through the HTTP/UI state', async () => {
    server = createMockConsoleServer();
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const initial = await fetch(`${baseUrl}/api/v1/mock-config`).then((response) => response.json()) as { name: string };
    const changedName = `${initial.name}-qa`;

    const update = await fetch(`${baseUrl}/api/v1/mock-config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: changedName }),
    });
    const afterUpdate = await fetch(`${baseUrl}/api/v1/mock-config`).then((response) => response.json()) as { name: string };
    const pageAfterUpdate = await fetch(`${baseUrl}/hci`).then((response) => response.text());

    expect(update.status).toBe(200);
    expect(afterUpdate.name).toBe(changedName);
    expect(pageAfterUpdate).toContain(`value="${changedName}"`);
    expect(pageAfterUpdate).toContain('<a href="#dashboard">Dashboard</a>');

    await fetch(`${baseUrl}/api/v1/mock-config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: initial.name }),
    });
    const restored = await fetch(`${baseUrl}/api/v1/mock-config`).then((response) => response.json()) as { name: string };
    expect(restored.name).toBe(initial.name);
  });
});
