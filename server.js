import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import multer from 'multer';
import { fileTypeFromFile } from 'file-type';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHmac, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const production = process.env.NODE_ENV === 'production';
const secret = process.env.SESSION_SECRET, password = process.env.ADMIN_PASSWORD;
if (!secret || secret.length < 32 || !password || password.length < 12 || !process.env.ADMIN_EMAIL || password.startsWith('replace-') || secret.startsWith('replace-')) throw new Error('Configure ADMIN_EMAIL, ADMIN_PASSWORD (12+ characters) and SESSION_SECRET (32+ random characters) in .env.');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
const uploadDir = path.resolve(process.env.UPLOAD_DIR || path.join(root, 'uploads'));
mkdirSync(dataDir, { recursive: true }); mkdirSync(uploadDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, 'gallery.sqlite'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS media (id INTEGER PRIMARY KEY, title TEXT NOT NULL, category_id INTEGER NOT NULL REFERENCES categories(id), filename TEXT NOT NULL UNIQUE, type TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, expires INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS media_category ON media(category_id);`);
const salt = randomBytes(16), passwordHash = scryptSync(password, salt, 64);
const sign = value => createHmac('sha256', secret).update(value).digest('hex');
const safeEqual = (a,b) => Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a),Buffer.from(b));
const app = express();
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: { directives: { 'img-src': ["'self'", 'data:'], 'media-src': ["'self'", 'blob:'], 'upgrade-insecure-requests': production ? [] : null } }, strictTransportSecurity: production ? undefined : false }));
app.use(express.json({ limit: '16kb' }));
app.use('/api', (req,res,next) => { res.set('Cache-Control','no-store'); if (!['GET','HEAD','OPTIONS'].includes(req.method) && req.get('X-Gallery-Request') !== '1') return res.status(403).json({error:'Invalid request origin.'}); next(); });
function sessionToken(req) {
 const cookie = req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('gallery_session='))?.slice(16);
 if (!cookie) return null;
 const [token, signature=''] = cookie.split('.');
 if (!safeEqual(sign(token),signature)) return null;
 return db.prepare('SELECT token FROM sessions WHERE token=? AND expires>?').get(token,Date.now())?.token;
}
function auth(req,res,next) { if (!sessionToken(req)) return res.status(401).json({error:'Please sign in again.'}); next(); }
app.get('/api/session',(req,res)=>res.json({authenticated:!!sessionToken(req)}));
app.post('/api/login',rateLimit({windowMs:900000,limit:10,standardHeaders:'draft-8',legacyHeaders:false,message:{error:'Too many attempts. Try again in 15 minutes.'}}),(req,res)=>{
 const candidate=typeof req.body.password==='string'?req.body.password:'';
 const matches=timingSafeEqual(scryptSync(candidate.slice(0,1024),salt,64),passwordHash);
 if (!matches || req.body.email!==process.env.ADMIN_EMAIL) return res.status(401).json({error:'Incorrect email or password.'});
 db.prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now());
 const token=randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions VALUES (?,?)').run(token,Date.now()+28800000);
 res.cookie('gallery_session',`${token}.${sign(token)}`,{httpOnly:true,secure:production,sameSite:'strict',maxAge:28800000,path:'/'}); res.json({ok:true});
});
app.post('/api/logout',(req,res)=>{const token=sessionToken(req);if(token)db.prepare('DELETE FROM sessions WHERE token=?').run(token);res.clearCookie('gallery_session',{path:'/'});res.json({ok:true});});
app.get('/api/categories',(req,res)=>res.json(db.prepare('SELECT c.*, COUNT(m.id) AS count FROM categories c LEFT JOIN media m ON m.category_id=c.id GROUP BY c.id ORDER BY c.name').all()));
app.post('/api/categories',auth,(req,res)=>{
 const name=typeof req.body.name==='string'?req.body.name.trim():'';
 if(!name || name.length>60)return res.status(400).json({error:'Use a category name between 1 and 60 characters.'});
 try{const result=db.prepare('INSERT INTO categories(name) VALUES (?)').run(name);res.status(201).json({id:Number(result.lastInsertRowid),name});}catch{res.status(409).json({error:'That category already exists.'});}
});
app.delete('/api/categories/:id',auth,(req,res)=>{if(db.prepare('SELECT id FROM media WHERE category_id=? LIMIT 1').get(req.params.id))return res.status(409).json({error:'Delete the media in this category first.'});db.prepare('DELETE FROM categories WHERE id=?').run(req.params.id);res.json({ok:true});});
app.get('/api/media',(req,res)=>{
 const q=String(req.query.q||'').slice(0,200),category=String(req.query.category||''),type=String(req.query.type||'');
 const where=`WHERE (m.title LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\') AND (?='' OR m.category_id=?) AND (?='' OR m.type=?)`;
 const search=`%${q.replace(/[\\%_]/g,'\\$&')}%`,args=[search,search,category,category,type,type];
 const total=db.prepare(`SELECT COUNT(*) AS n FROM media m JOIN categories c ON c.id=m.category_id ${where}`).get(...args).n;
 const pages=Math.max(1,Math.ceil(total/9)),page=Math.min(pages,Math.max(1,parseInt(req.query.page,10)||1));
 const items=db.prepare(`SELECT m.*, c.name AS category FROM media m JOIN categories c ON c.id=m.category_id ${where} ORDER BY m.id DESC LIMIT 9 OFFSET ?`).all(...args,(page-1)*9);
 res.json({items,total,page,pages});
});
const maxMB=Number(process.env.MAX_UPLOAD_MB||200);
const upload=multer({dest:uploadDir,limits:{fileSize:maxMB*1024*1024,files:1,fields:2,fieldSize:1024}});
const allowed=new Map([['image/jpeg','photo'],['image/png','photo'],['image/webp','photo'],['video/mp4','video'],['video/webm','video']]);
app.post('/api/media',auth,upload.single('file'),async(req,res,next)=>{
 let stored=req.file?.path;
 try{
  const title=typeof req.body.title==='string'?req.body.title.trim():'';
  if(!req.file || !title || title.length>120 || !db.prepare('SELECT id FROM categories WHERE id=?').get(req.body.category_id||''))throw Object.assign(new Error('Choose a category, file, and title of 1–120 characters.'),{status:400});
  const detected=await fileTypeFromFile(stored).catch(()=>null);
  if(!allowed.has(detected?.mime))throw Object.assign(new Error('Upload a JPEG, PNG, WebP, MP4, or WebM file.'),{status:400});
  const filename=`${randomBytes(24).toString('hex')}.${detected.ext}`,destination=path.join(uploadDir,filename);renameSync(stored,destination);stored=destination;
  const result=db.prepare('INSERT INTO media(title,category_id,filename,type) VALUES (?,?,?,?)').run(title,req.body.category_id,filename,allowed.get(detected.mime));res.status(201).json({id:Number(result.lastInsertRowid)});
 }catch(error){if(stored){try{unlinkSync(stored);}catch{}}next(error);}
});
app.delete('/api/media/:id',auth,(req,res,next)=>{
 const item=db.prepare('SELECT * FROM media WHERE id=?').get(req.params.id);if(!item)return res.status(404).json({error:'Media not found.'});
 try{unlinkSync(path.join(uploadDir,item.filename));}catch(e){if(e.code!=='ENOENT')return next(e);}
 db.prepare('DELETE FROM media WHERE id=?').run(item.id);res.json({ok:true});
});
app.use('/uploads',express.static(uploadDir,{dotfiles:'deny',immutable:true,maxAge:'1y'}));
app.use(express.static(path.join(root,'public')));
app.get('/admin',(req,res)=>res.sendFile(path.join(root,'public/index.html')));
app.use('/api',(req,res)=>res.status(404).json({error:'Not found.'}));
app.use((error,req,res,next)=>{if(error instanceof multer.MulterError)return res.status(400).json({error:error.code==='LIMIT_FILE_SIZE'?`File exceeds the ${maxMB} MB upload limit.`:'Invalid upload. Choose one file.'});const status=error.status||500;if(status===500)console.error(error);res.status(status).json({error:status===500?'Something went wrong. Please try again.':error.message});});
const server=app.listen(process.env.PORT||3000,()=>console.log(`The BLR Edit is ready at http://localhost:${server.address().port}`));
process.on('SIGTERM',()=>server.close(()=>{db.close();process.exit(0);}));

