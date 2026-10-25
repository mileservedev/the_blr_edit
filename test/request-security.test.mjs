import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../app.mjs';

test('Compressed JSON with trailing bytes is rejected without stopping the app', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'blr-security-'));
  let server;
  try {
    const app = await createApp({ store: { mediaOrigin: 'https://example.supabase.co' }, tempDir, email: 'test@example.com', password: 'test-password-12345', secret: 'test-only-secret-'.repeat(4) });
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'X-Gallery-Request': '1' }, body: Buffer.concat([gzipSync('{}'), Buffer.from('trailing bytes')]) });
    assert.equal(response.status, 415);
    assert.equal((await fetch(base + '/')).status, 200);
    const normal = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Gallery-Request': '1' }, body: JSON.stringify({ email: 'test@example.com', password: 'wrong' }) });
    assert.equal(normal.status, 401);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await rm(tempDir, { recursive: true, force: true });
  }
});
