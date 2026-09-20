// Local Supabase HTTP test double backed by PostgreSQL (PGlite).
// Exercises the production SDK and real setup.sql without cloud credentials.
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';

export async function startSupabaseFixture() {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema storage;
    create table storage.buckets(id text primary key, name text, public boolean,
      file_size_limit bigint, allowed_mime_types text[]);`);
  const schema = await readFile(new URL('../supabase/setup.sql', import.meta.url), 'utf8');
  await db.exec(schema);
  await db.exec(schema); // The setup must be safely rerunnable.
  const files = new Map();
  const faults = { upload: false, insert: false, remove: false };
  const key = 'sb_secret_test-only';
  const app = express();
  app.use((req, res, next) => {
    if (!req.path.startsWith('/storage/v1/object/public/') && req.get('apikey') !== key) return res.status(401).json({ message: 'Missing server key.' });
    next();
  });
  app.use(express.json());
  app.get('/storage/v1/bucket/gallery', async (req, res) => res.json((await db.query("select * from storage.buckets where id='gallery'")).rows[0]));
  app.post('/storage/v1/object/gallery/:filename', express.raw({ type: () => true, limit: '51mb' }), (req, res) => {
    if (faults.upload) return res.status(500).json({ message: 'Storage quota exceeded', statusCode: '500' });
    files.set(req.params.filename, { bytes: req.body, contentType: req.get('content-type') });
    res.json({ Key: 'gallery/' + req.params.filename });
  });
  app.delete('/storage/v1/object/gallery', (req, res) => {
    if (faults.remove) return res.status(500).json({ message: 'Storage unavailable', statusCode: '500' });
    const removed = req.body.prefixes.map(name => { files.delete(name); return { name }; });
    res.json(removed);
  });
  app.get('/storage/v1/object/public/gallery/:filename', (req, res) => {
    const file = files.get(req.params.filename);
    if (!file) return res.sendStatus(404);
    res.type(file.contentType);
    const range = req.get('range')?.match(/^bytes=(\d+)-(\d+)$/);
    if (range) {
      const start = Number(range[1]), end = Number(range[2]);
      return res.status(206).set('Content-Range', `bytes ${start}-${end}/${file.bytes.length}`).send(file.bytes.subarray(start, end + 1));
    }
    res.send(file.bytes);
  });
  app.post('/rest/v1/rpc/:name', async (req, res, next) => {
    try {
      if (req.params.name === 'gallery_categories') return res.json((await db.query('select * from public.gallery_categories()')).rows);
      const rpcArgs = {
        gallery_engagement: ['item_ids', 'browser_id'],
        gallery_like: ['item_id', 'browser_id', 'desired_like'],
        gallery_open: ['item_id', 'browser_id'],
      }[req.params.name];
      if (rpcArgs) {
        const params = rpcArgs.map(k => req.body[k]);
        const sql = req.params.name === 'gallery_engagement'
          ? 'select * from public.gallery_engagement($1,$2)'
          : `select public.${req.params.name}(${rpcArgs.map((_,i)=>'$'+(i+1)).join(',')}) as result`;
        const rows = (await db.query(sql,params)).rows;
        return res.json(req.params.name === 'gallery_engagement' ? rows : rows[0].result);
      }
      if (req.params.name !== 'gallery_search') return res.sendStatus(404);
      const b = req.body;
      const result = await db.query('select public.gallery_search($1,$2,$3,$4) as result', [b.search_text, b.category_filter, b.type_filter, b.requested_page]);
      res.json(result.rows[0].result);
    } catch (e) { next(e); }
  });
  const columns = {
    sessions: ['token', 'expires'], categories: ['id', 'name'], media: ['id', 'title', 'category_id', 'filename', 'type', 'created_at', 'instagram_url', 'youtube_url', 'description', 'photos'],
  };
  app.all('/rest/v1/:table', async (req, res, next) => {
    try {
      const table = req.params.table;
      if (!columns[table]) return res.sendStatus(404);
      const values = [], clauses = [];
      for (const [col, value] of Object.entries(req.query)) {
        if (!columns[table].includes(col)) continue;
        const [operator, ...rest] = String(value).split('.');
        const op = { eq: '=', gt: '>', lte: '<=' }[operator];
        if (!op) throw new Error('Unsupported test filter');
        values.push(rest.join('.')); clauses.push(`"${col}" ${op} $${values.length}`);
      }
      const where = clauses.length ? ' where ' + clauses.join(' and ') : '';
      let rows;
      if (req.method === 'GET') {
        const selected = (req.query.select || '*').split(',');
        if (!selected.every(c => c === '*' || columns[table].includes(c))) throw new Error('Unsupported selection');
        const limit = req.query.limit ? ` limit ${Number(req.query.limit)}` : '';
        rows = (await db.query(`select ${selected.join(',')} from public.${table}${where}${limit}`, values)).rows;
      } else if (req.method === 'POST') {
        if (table === 'media' && faults.insert) throw Object.assign(new Error('Insert rejected'), { code: '23514' });
        const keys = Object.keys(req.body);
        if (!keys.every(c => columns[table].includes(c))) throw new Error('Invalid columns');
        rows = (await db.query(`insert into public.${table} (${keys.join(',')}) values (${keys.map((_, i) => '$' + (i + 1)).join(',')}) returning *`, keys.map(k => k === 'photos' ? JSON.stringify(req.body[k]) : req.body[k]))).rows;
      } else if (req.method === 'PATCH') {
        const keys = Object.keys(req.body);
        if (!keys.every(c => columns[table].includes(c))) throw new Error('Invalid columns');
        const sets = keys.map(k => { values.push(req.body[k]); return `${k}=$${values.length}`; });
        rows = (await db.query(`update public.${table} set ${sets.join(',')}${where} returning *`, values)).rows;
      } else if (req.method === 'DELETE') {
        await db.query(`delete from public.${table}${where}`, values); return res.status(204).end();
      } else return res.sendStatus(405);
      if (req.get('accept')?.includes('vnd.pgrst.object')) return res.json(rows[0]);
      res.json(rows);
    } catch (e) { next(e); }
  });
  app.use((error, req, res, next) => res.status(400).json({ code: error.code || 'TEST_ERROR', message: error.message }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  return { db, files, faults, key, url: `http://127.0.0.1:${server.address().port}`,
    async close() { await new Promise(resolve => server.close(resolve)); await db.close(); } };
}
