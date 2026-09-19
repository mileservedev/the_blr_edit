'use strict';
// CommonJS entry: hosting launchers can observe listen() before require() returns.
// No third-party packages or ES modules are loaded before the listener is registered.
const http = require('http');
let application, tempDir, retryTimer, stopping = false;
const server = http.createServer((req, res) => {
  if (application) return application(req, res);
  res.statusCode = 503;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Retry-After', '30');
  const apiRequest = (req.url || '').startsWith('/api/');
  res.setHeader('Content-Type', apiRequest ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8');
  res.end(apiRequest
    ? JSON.stringify({ error: 'The collection is starting. Please try again shortly.' })
    : '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>The BLR Edit</title><body><h1>The collection is starting.</h1><p>Please refresh in a moment.</p></body></html>');
});
server.listen(process.env.PORT || 3000, function () {
  const address = this.address();
  console.log(typeof address === 'object' && address ? `The BLR Edit is listening on port ${address.port}` : 'The BLR Edit is listening on the hosting socket');
});
console.log('BLR startup: CommonJS HTTP listener registered');

const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');

async function initialize() {
  const { ADMIN_EMAIL: email, ADMIN_PASSWORD: password, SESSION_SECRET: secret } = process.env;
  if (!email || !password || password.length < 12 || !secret || secret.length < 32 || password.startsWith('replace-') || secret.startsWith('replace-')) {
    throw new Error('Configure ADMIN_EMAIL, ADMIN_PASSWORD (12+ characters) and SESSION_SECRET (32+ random characters).');
  }
  const { url, key } = require('./lib/config.cjs').readSupabaseConfig(process.env);
  const [{ createApp }, { createSupabaseStore }] = await Promise.all([import('./app.mjs'), import('./lib/supabase-store.mjs')]);
  const store = createSupabaseStore(url, key);
  tempDir = await mkdtemp(path.join(tmpdir(), 'blr-upload-'));
  const readyApp = await createApp({ store, email, password, secret, tempDir,
    production: process.env.NODE_ENV === 'production', trustProxy: process.env.TRUST_PROXY === '1' });
  async function connect() {
    if (stopping) return;
    try {
      await store.check();
      if (stopping) return;
      application = readyApp;
      console.log('Supabase checks passed. The BLR Edit is ready.');
    } catch {
      console.error('Supabase setup check failed. Verify project status, URL/key and supabase/setup.sql. Retrying in 30 seconds.');
      if (!stopping) retryTimer = setTimeout(connect, 30000);
    }
  }
  await connect();
}
setImmediate(() => initialize().catch(error => {
  // Only known configuration messages are exposed; never print SDK objects/secrets.
  console.error('Application initialization failed:', (error.code === 'SUPABASE_CONFIG' || /^(Configure |SUPABASE_URL)/.test(error.message)) ? error.message : 'Check runtime configuration, installed dependencies and temporary-directory permissions.');
}));
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  stopping = true;
  clearTimeout(retryTimer);
  server.close(async () => { if (tempDir) await rm(tempDir, { recursive: true, force: true }); process.exit(0); });
});
