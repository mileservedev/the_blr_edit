import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from './app.js';
import { createSupabaseStore } from './lib/supabase-store.js';

const { ADMIN_EMAIL: email, ADMIN_PASSWORD: password, SESSION_SECRET: secret, SUPABASE_URL: url, SUPABASE_SECRET_KEY: key } = process.env;
if (!email || !password || password.length < 12 || !secret || secret.length < 32 || password.startsWith('replace-') || secret.startsWith('replace-')) {
  throw new Error('Configure ADMIN_EMAIL, ADMIN_PASSWORD (12+ characters) and SESSION_SECRET (32+ random characters).');
}
if (!url || !key || !key.startsWith('sb_secret_') || key.includes('replace-')) {
  throw new Error('Configure SUPABASE_URL and a server-only SUPABASE_SECRET_KEY (sb_secret_...) in your environment.');
}
const parsedURL = new URL(url);
if (parsedURL.protocol !== 'https:' || parsedURL.username || parsedURL.password || parsedURL.pathname !== '/' || parsedURL.search || parsedURL.hash) {
  throw new Error('SUPABASE_URL must be the HTTPS project origin from Supabase, without a path or credentials.');
}
const store = createSupabaseStore(url, key);
try { await store.check(); }
catch { console.error('Supabase setup check failed. Verify your project is active, URL/key are correct, and supabase/setup.sql has been run.'); process.exit(1); }
const tempDir = await mkdtemp(path.join(tmpdir(), 'blr-upload-'));
const app = await createApp({ store, email, password, secret, tempDir,
  production: process.env.NODE_ENV === 'production', trustProxy: process.env.TRUST_PROXY === '1' });
const server = app.listen(process.env.PORT || 3000, () => console.log(`The BLR Edit is ready at http://localhost:${server.address().port}`));
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  server.close(async () => { await rm(tempDir, { recursive: true, force: true }); process.exit(0); });
});
