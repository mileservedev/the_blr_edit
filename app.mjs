import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import multer from 'multer';
import { fileTypeFromFile } from 'file-type';
import { randomBytes, createHash, createHmac, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
export const MAX_UPLOAD_BYTES = 50_000_000;
const allowed = new Map([
  ['image/jpeg', 'photo'], ['image/png', 'photo'], ['image/webp', 'photo'],
  ['video/mp4', 'video'], ['video/webm', 'video'],
]);
const problem = (status, message) => Object.assign(new Error(message), { status });
function instagramURL(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > 2048) throw problem(400, 'Enter a valid Instagram link.');
  let url;
  try { url = new URL(value.trim()); } catch { throw problem(400, 'Enter a full Instagram link beginning with https://.'); }
  if (url.protocol !== 'https:' || !['instagram.com', 'www.instagram.com'].includes(url.hostname) || url.username || url.password || url.port) throw problem(400, 'Use an https://instagram.com or https://www.instagram.com link.');
  return url.href;
}
function youtubeURL(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > 2048) throw problem(400, 'Enter a valid YouTube link.');
  let url;
  try { url = new URL(value.trim()); } catch { throw problem(400, 'Enter a full YouTube link beginning with https://.'); }
  if (url.protocol !== 'https:' || !['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(url.hostname) || url.username || url.password || url.port) throw problem(400, 'Use an HTTPS youtube.com or youtu.be link.');
  // Accept video/Shorts links, not arbitrary YouTube redirect endpoints.
  const videoId = url.hostname === 'youtu.be' ? url.pathname.slice(1) : url.pathname === '/watch' ? url.searchParams.get('v') : /^\/(?:shorts|embed|live)\/([a-zA-Z0-9_-]{11})\/?$/.exec(url.pathname)?.[1];
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId || '')) throw problem(400, 'Enter a YouTube video, Shorts, live, or youtu.be video link.');
  return url.href;
}
const validId = value => /^\d+$/.test(String(value)) && Number(value) > 0 && Number(value) <= 2147483647;

export async function createApp({ store, email, password, secret, tempDir, production = false, trustProxy = false }) {
  await mkdir(tempDir, { recursive: true });
  const salt = randomBytes(16), passwordHash = scryptSync(password, salt, 64);
  const sign = value => createHmac('sha256', secret).update(value).digest('hex');
  const app = express();
  if (trustProxy) app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: { directives: {
    'img-src': ["'self'", 'data:', store.mediaOrigin],
    'media-src': ["'self'", store.mediaOrigin],
    'upgrade-insecure-requests': production ? [] : null,
  } }, strictTransportSecurity: production ? undefined : false }));
  app.use(express.json({ limit: '16kb' }));
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('X-Gallery-Request') !== '1') {
      return res.status(403).json({ error: 'Invalid request origin.' });
    }
    let visitorCookie = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('gallery_visitor='))?.slice(16);
    let [visitor = '', signature = ''] = (visitorCookie || '').split('.');
    if (!/^[a-f0-9]{64}$/.test(visitor) || !/^[a-f0-9]{64}$/.test(signature) || !timingSafeEqual(Buffer.from(sign('visitor:' + visitor)), Buffer.from(signature))) {
      visitor = randomBytes(32).toString('hex');
      res.cookie('gallery_visitor', `${visitor}.${sign('visitor:' + visitor)}`, { httpOnly: true, secure: production, sameSite: 'lax', maxAge: 31536000000, path: '/' });
    }
    req.visitor = createHash('sha256').update(visitor).digest('hex');
    next();
  });
  async function sessionToken(req) {
    const cookie = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('gallery_session='))?.slice(16);
    if (!cookie) return null;
    const [token, signature = ''] = cookie.split('.');
    if (!/^[a-f0-9]{64}$/.test(token) || !/^[a-f0-9]{64}$/.test(signature)) return null;
    if (!timingSafeEqual(Buffer.from(sign(token)), Buffer.from(signature))) return null;
    return (await store.session(token))?.token;
  }
  async function auth(req, res, next) {
    if (!await sessionToken(req)) return res.status(401).json({ error: 'Please sign in again.' });
    next();
  }
  app.get('/api/session', async (req, res) => res.json({ authenticated: !!await sessionToken(req) }));
  app.post('/api/login', rateLimit({ windowMs: 900000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'Too many attempts. Try again in 15 minutes.' } }), async (req, res) => {
    const candidate = typeof req.body?.password === 'string' ? req.body.password : '';
    const matches = timingSafeEqual(scryptSync(candidate.slice(0, 1024), salt, 64), passwordHash);
    if (!matches || req.body?.email !== email) return res.status(401).json({ error: 'Incorrect email or password.' });
    const token = randomBytes(32).toString('hex');
    await store.addSession(token, Date.now() + 28800000);
    res.cookie('gallery_session', `${token}.${sign(token)}`, { httpOnly: true, secure: production, sameSite: 'strict', maxAge: 28800000, path: '/' });
    res.json({ ok: true });
  });
  app.post('/api/logout', async (req, res) => {
    const token = await sessionToken(req);
    if (token) await store.deleteSession(token);
    res.clearCookie('gallery_session', { path: '/' }); res.json({ ok: true });
  });
  app.get('/api/categories', async (req, res) => res.json(await store.categories()));
  app.post('/api/categories', auth, async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name || name.length > 60) throw problem(400, 'Use a category name between 1 and 60 characters.');
    res.status(201).json(await store.addCategory(name));
  });
  app.delete('/api/categories/:id', auth, async (req, res) => {
    if (!validId(req.params.id)) throw problem(400, 'Invalid category.');
    await store.deleteCategory(Number(req.params.id)); res.json({ ok: true });
  });
  app.get('/api/media', async (req, res) => {
    const category = String(req.query.category || ''), type = String(req.query.type || '');
    if (category && !validId(category)) throw problem(400, 'Invalid category.');
    if (!['', 'photo', 'video'].includes(type)) throw problem(400, 'Invalid media type.');
    res.json(await store.search({
      search_text: String(req.query.q || '').slice(0, 200), category_filter: category ? Number(category) : null,
      type_filter: type, requested_page: Math.min(2147483647, Math.max(1, parseInt(req.query.page, 10) || 1)),
    }, req.visitor));
  });
  const upload = multer({ dest: tempDir, limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 4, fieldSize: 2048 } });
  let uploading = false;
  app.post('/api/media', auth, (req, res, next) => {
    if (uploading) return res.status(429).json({ error: 'Another upload is in progress. Please try again shortly.' });
    uploading = true;
    req.uploadReference = randomBytes(6).toString('hex');
    req.uploadStage = 'receiving file';
    console.log('Upload started:', req.uploadReference);
    // Hold the slot until storage transfer and cleanup finish, even if the browser disconnects.
    upload.single('file')(req, res, async parseError => {
      let uploadResult, uploadError;
      try {
        if (parseError) throw parseError;
        req.uploadStage = 'validating file';
        const instagram_url = instagramURL(req.body.instagram_url);
        const youtube_url = youtubeURL(req.body.youtube_url);
        const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
        if (!req.file || !title || title.length > 120 || !validId(req.body.category_id)) {
          throw problem(400, 'Choose a category, file, and title of 1–120 characters.');
        }
        if (!await store.category(Number(req.body.category_id))) throw problem(400, 'Choose an existing category.');
        const detected = await fileTypeFromFile(req.file.path).catch(() => null);
        if (['video/3gpp', 'video/3gpp2'].includes(detected?.mime)) throw problem(400, '3GP videos are not supported. Convert the video to MP4 (H.264 video and AAC audio), then upload it again. Renaming the file is not enough.');
        if (!allowed.has(detected?.mime)) throw problem(400, 'Upload a JPEG, PNG, WebP, MP4, or WebM file.');
        const filename = `${randomBytes(24).toString('hex')}.${detected.ext}`;
        req.uploadStage = 'saving file to Supabase Storage';
        console.log('Upload validated:', req.uploadReference, 'bytes:', req.file.size, 'format:', detected.mime);
        await store.upload(filename, req.file.path, detected.mime);
        req.uploadStage = 'saving gallery record';
        let result;
        try {
          result = await store.addMedia({ title, category_id: Number(req.body.category_id), filename, type: allowed.get(detected.mime), instagram_url, youtube_url });
        } catch (error) {
          // On a definitive DB rejection, remove the uploaded object. A network failure
          // may have committed the row: retain the file for reconciliation in that case.
          if (/^\d{5}$/.test(error.code || '')) {
            try { await store.removeFile(filename); }
            catch { console.error('Orphaned storage object requires cleanup:', filename); }
          } else console.error('Verify media row/storage object after uncertain write:', filename);
          throw error;
        }
        console.log('Upload complete:', req.uploadReference, 'media:', result.id);
        uploadResult = result;
      } catch (error) { uploadError = error; }
      finally {
        if (req.file?.path) await rm(req.file.path, { force: true }).catch(() => {});
        uploading = false;
      }
      if (uploadError) next(uploadError);
      else res.status(201).json(uploadResult);
    });
  });
  const engagementLimit = rateLimit({ windowMs: 60000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Please wait a moment before trying again.' } });
  app.post('/api/media/:id/like', engagementLimit, async (req, res) => {
    if (!validId(req.params.id) || typeof req.body?.liked !== 'boolean') throw problem(400, 'Invalid like request.');
    const id = Number(req.params.id);
    if (!await store.media(id)) throw problem(404, 'Media not found.');
    res.json(await store.like(id, req.visitor, req.body.liked));
  });
  app.post('/api/media/:id/open', engagementLimit, async (req, res) => {
    if (!validId(req.params.id)) throw problem(400, 'Invalid media.');
    const id = Number(req.params.id);
    // Administrators can preview without recording a public view.
    if (await sessionToken(req)) {
      if (!await store.media(id)) throw problem(404, 'Media not found.');
      return res.json({ redirect: null });
    }
    const result = await store.open(id, req.visitor);
    if (!result) throw problem(404, 'Media not found.');
    // Keep every opening local; external viewing is an explicit link in the UI.
    res.json({ redirect: null });
  });
  app.patch('/api/media/:id', auth, async (req, res) => {
    if (!validId(req.params.id)) throw problem(400, 'Invalid media.');
    const links = {};
    if (Object.hasOwn(req.body || {}, 'instagram_url')) links.instagram_url = instagramURL(req.body.instagram_url);
    if (Object.hasOwn(req.body || {}, 'youtube_url')) links.youtube_url = youtubeURL(req.body.youtube_url);
    if (!Object.keys(links).length) throw problem(400, 'Provide an Instagram or YouTube link field.');
    const result = await store.setLinks(Number(req.params.id), links);
    if (!result) throw problem(404, 'Media not found.');
    res.json(result);
  });
  app.delete('/api/media/:id', auth, async (req, res) => {
    if (!validId(req.params.id)) throw problem(400, 'Invalid media.');
    const item = await store.media(Number(req.params.id));
    if (!item) throw problem(404, 'Media not found.');
    // Retain the row on a storage error, allowing the administrator to retry.
    await store.removeFile(item.filename);
    await store.deleteMedia(item.id);
    res.json({ ok: true });
  });
  app.use(express.static(path.join(root, 'public')));
  app.get('/admin', (req, res) => res.sendFile(path.join(root, 'public/index.html')));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
  app.use((error, req, res, next) => {
    if (req.uploadReference) {
      const code = String(error.code || error.name || 'unknown');
      console.error('Upload failed:', req.uploadReference, 'stage:', req.uploadStage, 'code:', /^[a-zA-Z0-9_]{1,64}$/.test(code) ? code : 'unknown', 'upstream status:', Number(error.statusCode || error.status) || 'unknown');
    }
    if (error instanceof multer.MulterError) return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'File exceeds the 50 MB upload limit.' : 'Invalid upload. Choose one file.' });
    if (error.code === '23505') return res.status(409).json({ error: 'That name already exists.' });
    if (['23503', '23001'].includes(error.code)) return res.status(409).json({ error: req.method === 'DELETE' ? 'Delete the media in this category first.' : 'The selected category no longer exists.' });
    const status = Number(error.status);
    if (status >= 400 && status < 500) return res.status(status).json({ error: error.message });
    // Do not log SDK request objects, headers, or credentials.
    console.error('Gallery request failed:', error.code || error.name || 'upstream');
    res.status(503).json({ error: req.uploadReference ? `Upload failed while ${req.uploadStage}. Reference: ${req.uploadReference}. Check the matching Hostinger runtime log.` : 'Storage or database is unavailable. Please check your Supabase project status and try again.' });
  });
  return app;
}
