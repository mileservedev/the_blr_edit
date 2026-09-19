import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Hostinger requires listen() immediately. Load the application and contact
// Supabase only after the hosting listener has been registered.
const host = express();
host.disable('x-powered-by');
let application, tempDir, retryTimer, stopping = false;
host.use((req, res, next) => {
  if (application) return application(req, res, next);
  res.set({ 'Cache-Control': 'no-store', 'Retry-After': '30' });
  if (req.path.startsWith('/api/')) return res.status(503).json({ error: 'The collection is starting. Please try again shortly.' });
  res.status(503).type('html').send('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>The BLR Edit</title><body><h1>The collection is starting.</h1><p>Please refresh in a moment.</p></body></html>');
});
const server = host.listen(process.env.PORT || 3000, () => {
  const address = server.address();
  console.log(typeof address === 'object' && address ? `The BLR Edit is listening on port ${address.port}` : 'The BLR Edit is listening on the hosting socket');
});

async function initialize() {
  const { ADMIN_EMAIL: email, ADMIN_PASSWORD: password, SESSION_SECRET: secret, SUPABASE_URL: url, SUPABASE_SECRET_KEY: key } = process.env;
  if (!email || !password || password.length < 12 || !secret || secret.length < 32 || password.startsWith('replace-') || secret.startsWith('replace-')) {
    throw new Error('Configure ADMIN_EMAIL, ADMIN_PASSWORD (12+ characters) and SESSION_SECRET (32+ random characters).');
  }
  if (!url || !key || !key.startsWith('sb_secret_') || key.includes('replace-')) {
    throw new Error('Configure SUPABASE_URL and a server-only SUPABASE_SECRET_KEY (sb_secret_...) in your environment.');
  }
  let parsedURL;
  try { parsedURL = new URL(url); } catch { throw new Error('SUPABASE_URL must be a valid HTTPS project origin.'); }
  if (parsedURL.protocol !== 'https:' || parsedURL.username || parsedURL.password || parsedURL.pathname !== '/' || parsedURL.search || parsedURL.hash) {
    throw new Error('SUPABASE_URL must be the HTTPS project origin from Supabase, without a path or credentials.');
  }
  const [{ createApp }, { createSupabaseStore }] = await Promise.all([import('./app.js'), import('./lib/supabase-store.js')]);
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
initialize().catch(error => {
  // Only known configuration messages are exposed; never print SDK objects/secrets.
  console.error('Application initialization failed:', /^(Configure |SUPABASE_URL)/.test(error.message) ? error.message : 'Check runtime configuration, installed dependencies and temporary-directory permissions.');
});
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  stopping = true;
  clearTimeout(retryTimer);
  server.close(async () => { if (tempDir) await rm(tempDir, { recursive: true, force: true }); process.exit(0); });
});
