import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp, MAX_UPLOAD_BYTES } from '../app.js';
import { createSupabaseStore } from '../lib/supabase-store.js';
import { startSupabaseFixture } from '../test-support/supabase-fixture.js';

test('Supabase schema, SDK, admin, media lifecycle and failure handling', { timeout: 120000 }, async () => {
  const fixture = await startSupabaseFixture();
  const tempDir = await mkdtemp(path.join(tmpdir(), 'blr-test-'));
  let server;
  try {
    const store = createSupabaseStore(fixture.url, fixture.key);
    await store.check();
    const settings = { store, tempDir, email: 'test@example.com', password: 'test-password-12345', secret: 'test-only-secret-'.repeat(4) };
    const start = async () => {
      const app = await createApp(settings);
      return new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    };
    server = await start();
    let base = `http://127.0.0.1:${server.address().port}`, cookie = '';
    const request = (url, options = {}) => fetch(base + url, { ...options, headers: { 'X-Gallery-Request': '1', ...(cookie ? { Cookie: cookie } : {}), ...options.headers } });
    const json = (url, body) => request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await json('/api/categories', { name: 'Travel' })).status, 401);
    assert.equal((await json('/api/login', { email: settings.email, password: 'bad' })).status, 401);
    const login = await json('/api/login', { email: settings.email, password: settings.password });
    assert.equal(login.status, 200); cookie = login.headers.get('set-cookie').split(';')[0];
    assert.match(login.headers.get('set-cookie'), /HttpOnly/);
    assert.equal((await (await request('/api/session')).json()).authenticated, true);
    const category = await (await json('/api/categories', { name: 'Travel' })).json();
    assert.ok(category.id);
    assert.equal((await json('/api/categories', { name: 'travel' })).status, 409);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
    const upload = (title, bytes = png, filename = 'photo.png') => {
      const form = new FormData(); form.set('title', title); form.set('category_id', category.id);
      form.set('file', new Blob([bytes]), filename); return request('/api/media', { method: 'POST', body: form });
    };
    for (let i = 0; i < 10; i++) assert.equal((await upload(`Moment ${i}`)).status, 201);
    const page = await (await request('/api/media')).json();
    assert.equal(page.total, 10); assert.equal(page.items.length, 9); assert.equal(page.pages, 2);
    assert.equal((await (await request('/api/media?page=2')).json()).items.length, 1);
    assert.equal((await (await request('/api/media?q=Moment%203')).json()).total, 1);
    assert.equal((await (await request('/api/media?q=travel')).json()).total, 10);
    assert.equal((await (await request('/api/media?type=video')).json()).total, 0);
    assert.equal((await (await request('/api/media?q=%25')).json()).total, 0);
    assert.equal((await (await request('/api/media?page=999')).json()).page, 2);
    assert.equal((await request('/api/media?category=bad')).status, 400);
    assert.equal((await request('/api/media?type=bad')).status, 400);
    assert.ok(Number.isFinite(Date.parse(page.items[0].created_at)));
    assert.match(page.items[0].url, /\/storage\/v1\/object\/public\/gallery\//);
    const range = await fetch(page.items[0].url, { headers: { Range: 'bytes=0-7' } }); assert.equal(range.status, 206);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), png.subarray(0, 8));
    const csp = (await request('/')).headers.get('content-security-policy'); assert.ok(csp.includes(fixture.url));
    assert.equal((await request('/api/categories/' + category.id, { method: 'DELETE' })).status, 409);
    assert.equal((await upload('Fake', Buffer.from('not an image'))).status, 400);
    assert.equal((await upload('Too large', Buffer.alloc(MAX_UPLOAD_BYTES + 1))).status, 400);
    assert.equal((await fetch(base + '/api/categories', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Blocked' }) })).status, 403);
    fixture.faults.upload = true;
    assert.equal((await upload('Storage failure')).status, 503);
    fixture.faults.upload = false;
    fixture.faults.insert = true;
    const before = fixture.files.size;
    assert.equal((await upload('DB failure')).status, 503);
    assert.equal(fixture.files.size, before); // Successful storage upload rolled back.
    fixture.faults.insert = false;
    fixture.faults.remove = true;
    assert.equal((await request('/api/media/' + page.items[0].id, { method: 'DELETE' })).status, 503);
    assert.ok(await store.media(page.items[0].id)); // Row retained for retry.
    fixture.faults.remove = false;
    // Simulate Hostinger process replacement; sessions and media remain in Supabase.
    await new Promise(resolve => server.close(resolve));
    server = await start(); base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await (await request('/api/session')).json()).authenticated, true);
    assert.equal((await (await request('/api/media')).json()).total, 10);
    const all = [...page.items, ...(await (await request('/api/media?page=2')).json()).items];
    for (const m of all) assert.equal((await request('/api/media/' + m.id, { method: 'DELETE' })).status, 200);
    assert.equal(fixture.files.size, 0);
    assert.equal((await request('/api/categories/' + category.id, { method: 'DELETE' })).status, 200);
    await request('/api/logout', { method: 'POST' });
    assert.equal((await (await request('/api/session')).json()).authenticated, false);
    // Verify actual PostgreSQL permissions, not just application authorization.
    for (const role of ['anon', 'authenticated']) {
      await fixture.db.exec(`set role ${role}`);
      await assert.rejects(fixture.db.query('select * from public.sessions'), /permission denied/);
      await assert.rejects(fixture.db.query('select * from public.gallery_categories()'), /permission denied/);
      await fixture.db.exec('reset role');
    }
    await fixture.db.exec('set role service_role');
    await fixture.db.query('select * from public.gallery_categories()');
    await fixture.db.exec('reset role');
    // Cleanup is asynchronous after the HTTP response finishes.
    for (let i = 0; i < 20 && (await readdir(tempDir)).length; i++) await new Promise(r => setTimeout(r, 10));
    assert.deepEqual(await readdir(tempDir), []);
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await fixture.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});
