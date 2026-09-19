import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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


test('CommonJS hosting launcher intercepts listen synchronously during require', () => {
  const probe = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const Module = require('node:module');
    const originalLoad = Module._load;
    let called = false;
    Module._load = function (name, ...args) {
      if (name === 'http') return {
        createServer(handler) {
          assert.equal(typeof handler, 'function');
          return { listen() { called = true; return this; }, close() {} };
        }
      };
      if (name === 'express' || name === '@supabase/supabase-js') {
        throw new Error('Third-party dependency loaded before bootstrap completed');
      }
      return originalLoad.call(this, name, ...args);
    };
    require('./server.js');
    assert.equal(called, true, 'listen must run before require returns');
    console.log('SYNCHRONOUS_LISTENER_OK');
    process.exit(0);
  `], { timeout: 3000, encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.stderr || String(probe.error || 'probe failed'));
  assert.match(probe.stdout, /SYNCHRONOUS_LISTENER_OK/);
});
