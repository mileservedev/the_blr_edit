import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('Hostinger listener starts before Supabase or application initialization', { timeout: 10000 }, async () => {
  const child = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: '0', ADMIN_EMAIL: '', ADMIN_PASSWORD: '', SESSION_SECRET: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.on('data', data => errors += data);
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('listen() was not called within 3 seconds')), 3000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.stdout.on('data', data => {
        const match = String(data).match(/listening on port (\d+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    });
    const response = await fetch(`http://localhost:${port}/api/categories`);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '30');
    assert.match((await response.json()).error, /starting/);
    assert.match(errors, /Configure ADMIN_EMAIL/);
    assert.equal(child.exitCode, null);
  } finally {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
  }
});
