import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp, MAX_UPLOAD_BYTES } from '../app.mjs';
import { createSupabaseStore } from '../lib/supabase-store.mjs';
import { startSupabaseFixture } from '../test-support/supabase-fixture.mjs';

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
    assert.equal(login.status, 200); cookie = login.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
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
    // ISO BMFF MP4 signature fixture: validates video upload/metadata, not playback.
    const mp4 = Buffer.from('00000018667479706d703432000000006d70343269736f6d', 'hex');
    const threeGP = Buffer.from('000000186674797033677035000000003367703569736f6d', 'hex');
    const unsupportedVideo = await upload('3GP test', threeGP, 'clip.3gp');
    assert.equal(unsupportedVideo.status, 400);
    assert.match((await unsupportedVideo.json()).error, /3GP videos are not supported.*Convert/);
    const videoUpload = await upload('Video test', mp4, 'clip.mp4');
    assert.equal(videoUpload.status, 201);
    const videoId = (await videoUpload.json()).id;
    const videos = await (await request('/api/media?type=video')).json();
    assert.equal(videos.total, 1);
    assert.equal(videos.items[0].id, videoId);
    assert.equal(fixture.files.get(videos.items[0].filename).contentType, 'video/mp4');
    assert.deepEqual(Buffer.from(await (await fetch(videos.items[0].url)).arrayBuffer()), mp4);
    assert.equal((await request('/api/media/' + videoId, { method: 'DELETE' })).status, 200);
    fixture.faults.upload = true;
    const failedUpload = await upload('Storage failure');
    assert.equal(failedUpload.status, 503);
    assert.match((await failedUpload.json()).error, /saving file to Supabase Storage.*Reference:/);
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
    const mediaId = page.items[0].id;
    const instagram = 'https://www.instagram.com/reel/example/';
    const updateLink = value => request('/api/media/' + mediaId, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instagram_url: value }) });
    assert.equal((await updateLink('https://instagram.com.attacker.example/reel/a')).status, 400);
    assert.equal((await updateLink('javascript:alert(1)')).status, 400);
    assert.equal((await updateLink(instagram)).status, 200);
    const visitor = () => {
      let visitorCookie = '';
      return async (route, body) => {
        const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Gallery-Request': '1', 'Content-Type': 'application/json', Cookie: visitorCookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const incoming = response.headers.getSetCookie().find(c => c.startsWith('gallery_visitor='));
        if (incoming) visitorCookie = incoming.split(';')[0];
        return response;
      };
    };
    const browserA = visitor(), browserB = visitor();
    await browserA('/api/categories'); await browserB('/api/categories');
    const likeRoute = `/api/media/${mediaId}/like`, openRoute = `/api/media/${mediaId}/open`;
    let liked = await (await browserA(likeRoute, { liked: true })).json();
    assert.equal(Number(liked.likes), 1); assert.equal(liked.liked, true);
    liked = await (await browserA(likeRoute, { liked: true })).json();
    assert.equal(Number(liked.likes), 1); // Repeated requests cannot duplicate a browser's like.
    assert.equal(Number((await (await browserB(likeRoute, { liked: true })).json()).likes), 2);
    assert.equal(Number((await (await browserA(likeRoute, { liked: false })).json()).likes), 1);
    assert.equal((await (await browserA(openRoute, {})).json()).redirect, null);
    assert.equal((await (await browserA(openRoute, {})).json()).redirect, null);
    assert.equal((await (await browserB(openRoute, {})).json()).redirect, null);
    const visitorGallery = await (await browserA('/api/media')).json();
    assert.equal(visitorGallery.items.find(m => m.id === mediaId).viewed, true);
    assert.equal(visitorGallery.items.find(m => m.id === mediaId).liked, false);
    const noLinkRoute = `/api/media/${page.items[1].id}/open`;
    assert.equal((await (await browserA(noLinkRoute, {})).json()).redirect, null);
    assert.equal((await (await browserA(noLinkRoute, {})).json()).redirect, null);
    assert.equal((await (await request(openRoute, { method: 'POST' })).json()).redirect, null); // Admin preview bypass.
    assert.equal((await browserA(`/api/media/2147483647/open`, {})).status, 404);
    assert.equal((await updateLink('')).status, 200);
    assert.equal((await (await browserA(openRoute, {})).json()).redirect, null);
    const youtube = 'https://youtu.be/abcdefghijk';
    const updateYoutube = value => request('/api/media/' + mediaId, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ youtube_url: value }) });
    assert.equal((await updateYoutube('https://youtube.com.attacker.example/watch?v=abcdefghijk')).status, 400);
    assert.equal((await updateYoutube('https://www.youtube.com/redirect?q=https://example.com')).status, 400);
    assert.equal((await updateYoutube(youtube)).status, 200);
    const browserC = visitor();
    await browserC('/api/categories');
    assert.equal((await (await browserC(openRoute, {})).json()).redirect, null);
    assert.equal((await (await browserC(openRoute, {})).json()).redirect, null);
    assert.equal((await updateLink(instagram)).status, 200);
    assert.equal((await (await browserC(openRoute, {})).json()).redirect, null);
    assert.equal((await updateLink('')).status, 200);
    assert.equal((await (await browserC(openRoute, {})).json()).redirect, null); // Editing Instagram preserves YouTube.
    assert.equal((await updateYoutube('https://www.youtube.com/shorts/abcdefghijk')).status, 200);
    assert.equal((await (await browserC(openRoute, {})).json()).redirect, null);
    assert.equal((await updateYoutube('')).status, 200);
    assert.equal((await (await browserC(openRoute, {})).json()).redirect, null);
    // Simulate Hostinger process replacement; sessions and media remain in Supabase.
    await new Promise(resolve => server.close(resolve));
    server = await start(); base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await (await request('/api/session')).json()).authenticated, true);
    assert.equal((await (await request('/api/media')).json()).total, 10);
    const all = [...page.items, ...(await (await request('/api/media?page=2')).json()).items];
    for (const m of all) assert.equal((await request('/api/media/' + m.id, { method: 'DELETE' })).status, 200);
    assert.equal(fixture.files.size, 0);
    assert.equal(Number((await fixture.db.query('select count(*) as n from public.media_engagement')).rows[0].n), 0);
    assert.equal((await request('/api/categories/' + category.id, { method: 'DELETE' })).status, 200);
    await request('/api/logout', { method: 'POST' });
    assert.equal((await (await request('/api/session')).json()).authenticated, false);
    // Verify actual PostgreSQL permissions, not just application authorization.
    for (const role of ['anon', 'authenticated']) {
      await fixture.db.exec(`set role ${role}`);
      await assert.rejects(fixture.db.query('select * from public.sessions'), /permission denied/);
      await assert.rejects(fixture.db.query('select * from public.media_engagement'), /permission denied/);
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
