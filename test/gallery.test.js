import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

test('admin, upload, search, pagination, streaming and deletion', async () => {
 const dir=await mkdtemp(path.join(tmpdir(),'blr-test-'));
 const child=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:'0',NODE_ENV:'test',ADMIN_EMAIL:'test@example.com',ADMIN_PASSWORD:'test-password-12345',SESSION_SECRET:'test-only-secret-'.repeat(4),DATA_DIR:path.join(dir,'data'),UPLOAD_DIR:path.join(dir,'uploads')},stdio:['ignore','pipe','pipe']});
 let stderr='';child.stderr.on('data',d=>stderr+=d);
 try {
 const base=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Server startup timed out: '+stderr)),10000);child.stdout.on('data',d=>{const match=String(d).match(/http:\/\/localhost:(\d+)/);if(match){clearTimeout(timer);resolve(match[0]);}});child.once('exit',()=>{clearTimeout(timer);reject(new Error(stderr));});});
 let cookie='';
 const request=(url,options={})=>fetch(base+url,{...options,headers:{'X-Gallery-Request':'1',...(cookie?{Cookie:cookie}:{}),...options.headers}});
 const json=(url,body)=>request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await json('/api/categories',{name:'Travel'})).status,401);
 assert.equal((await json('/api/login',{email:'test@example.com',password:'bad'})).status,401);
 const login=await json('/api/login',{email:'test@example.com',password:'test-password-12345'});assert.equal(login.status,200);cookie=login.headers.get('set-cookie').split(';')[0];
 assert.equal((await (await request('/api/session')).json()).authenticated,true);
 const category=await (await json('/api/categories',{name:'Travel'})).json();assert.ok(category.id);
 assert.equal((await json('/api/categories',{name:'travel'})).status,409);
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
 for(let i=0;i<10;i++){const form=new FormData();form.set('title',`Moment ${i}`);form.set('category_id',category.id);form.set('file',new Blob([png],{type:'image/png'}),'photo.png');assert.equal((await request('/api/media',{method:'POST',body:form})).status,201);}
 const page=await (await request('/api/media')).json();assert.equal(page.total,10);assert.equal(page.items.length,9);assert.equal(page.pages,2);
 assert.equal((await (await request('/api/media?page=2')).json()).items.length,1);
 assert.equal((await (await request('/api/media?q=Moment%203')).json()).total,1);
 assert.equal((await (await request('/api/media?type=video')).json()).total,0);
 assert.equal((await (await request('/api/media?q=%25')).json()).total,0);
 const range=await request('/uploads/'+page.items[0].filename,{headers:{Range:'bytes=0-7'}});assert.equal(range.status,206);
 assert.equal((await request('/api/categories/'+category.id,{method:'DELETE'})).status,409);
 const invalid=new FormData();invalid.set('title','Fake');invalid.set('category_id',category.id);invalid.set('file',new Blob(['not an image'],{type:'image/png'}),'fake.png');assert.equal((await request('/api/media',{method:'POST',body:invalid})).status,400);
 assert.equal((await fetch(base+'/api/categories',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({name:'Blocked'})})).status,403);
 const all=[...page.items,...(await (await request('/api/media?page=2')).json()).items];for(const m of all)assert.equal((await request('/api/media/'+m.id,{method:'DELETE'})).status,200);
 assert.equal((await request('/api/categories/'+category.id,{method:'DELETE'})).status,200);
 await request('/api/logout',{method:'POST'});assert.equal((await (await request('/api/session')).json()).authenticated,false);
 } finally { const exited=once(child,'exit');child.kill();await exited;await rm(dir,{recursive:true,force:true}); }
});
