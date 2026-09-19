# The BLR Edit

A Node.js media archive with a responsive gold, black and white interface. Public visitors can search titles and categories, filter photos/videos, browse nine items per page, and open photos or play videos. The admin area supports category creation and deletion, titled uploads with progress, and media deletion.

## Run locally

Requires Node.js 22.13+ (Node 24 recommended).

1. Copy `.env.example` to `.env`.
2. Set `ADMIN_EMAIL`, a unique `ADMIN_PASSWORD` of at least 12 characters, and a random `SESSION_SECRET` of at least 32 characters. No default account is included.
3. Generate a secret with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`.
4. Run `npm install`, then `npm start`.
5. Open http://localhost:3000 for the gallery or http://localhost:3000/admin to sign in.

`npm run build` checks JavaScript syntax; no frontend compilation is needed. `npm test` runs an isolated integration test of authentication, uploads, search, pagination, byte-range serving, invalid file rejection, and deletion. Tests use a temporary database and do not modify your collection.

## Uploads and storage

Supported formats: JPEG, PNG, WebP, MP4 and WebM. The default upload limit is 200 MB, configurable with `MAX_UPLOAD_MB`. File signatures are checked; filenames are randomly generated. Use H.264/AAC MP4 for broad browser compatibility. Videos are streamed by the static server with byte-range support; this app does not transcode videos or generate poster images. All published media is public.

SQLite stores categories, media metadata, and sessions in `DATA_DIR/gallery.sqlite`; original media files are stored in `UPLOAD_DIR`. Both locations must be writable and persistent. Run a single application instance. There is no sample content; the gallery starts empty. Change the branding in `public/index.html` and `public/app.js`.

Admin credentials are read from environment variables. Password comparisons use scrypt and constant-time comparison. Sessions expire after eight hours, use HttpOnly/SameSite cookies, and use Secure cookies in production. Mutating endpoints require a custom request header; cross-origin access is not enabled. Login attempts are rate-limited. To invalidate all sessions, rotate `SESSION_SECRET` and restart. Keep `.env` private and excluded from source control.

## Hostinger deployment

Hostinger documents Node.js support on Business and Cloud plans, as well as VPS hosting. Use a Node.js application environment, not a static or PHP-only website:
https://www.hostinger.com/support/node-js-hosting-options-at-hostinger/
https://www.hostinger.com/support/how-to-deploy-a-nodejs-website-in-hostinger/

### Managed Node.js hosting

1. In hPanel add a Node.js web app, then import your Git repository or upload the project files. Do not upload `.env`, `node_modules`, or local test data.
2. Select Node 24 (or 22.13+), Express where a framework is requested, and `server.js` as the entry file. Install with `npm install`; build command `npm run build`; start command `npm start`. Preserve the port supplied by Hostinger.
3. Add the variables from `.env.example` in hPanel. Use your own admin email, strong password and random session secret. Set `NODE_ENV=production` and enable HTTPS on the domain.
4. Set `DATA_DIR` and `UPLOAD_DIR` to persistent writable directories outside the replaceable application release directory. **Confirm with Hostinger that these locations survive redeployment and restart before uploading real content.** Filesystem durability is a deployment requirement, not something this repository can guarantee. If your managed plan cannot provide persistent paths, use the VPS instructions below or adapt storage to a managed database and object store.
5. Set `TRUST_PROXY=1` only if Hostinger confirms one trusted proxy hop to your application. Confirm request/upload size and timeout limits support your chosen `MAX_UPLOAD_MB`.
6. Sign in at `/admin`, create a category, upload a test photo and video, then verify persistence after a restart and redeployment.

### Hostinger VPS (explicit persistent storage)

Install Node 24. Put code in `/var/www/blr-edit` and create `/var/lib/blr-edit/data` and `/var/lib/blr-edit/uploads`, owned by the unprivileged application service account. Set `DATA_DIR` and `UPLOAD_DIR` to these absolute paths. Run one Node process with systemd or a process manager and restart on failure. Keep the environment file readable only by the service account.

Reverse-proxy HTTPS through Nginx to `127.0.0.1:3000`; enable an SSL certificate. Set `NODE_ENV=production`, `PORT=3000`, `TRUST_PROXY=1` and configure Nginx's `client_max_body_size 201m` and `proxy_read_timeout 300s` for the default upload limit. Forward Host, X-Forwarded-For and X-Forwarded-Proto. Allow public access only to ports 80/443; keep port 3000 private. Serve uploads through Node for range requests or configure equivalent Nginx media serving.

Back up the SQLite database and uploads together. Stop the application during a simple filesystem backup so the database and its WAL files remain consistent. Store backups off-server and test a restore. Do not overwrite the persistent directories when deploying new code.

## Verification status

Dependencies installed successfully. `npm run build` passed JavaScript syntax checks, and `npm test` passed the integration test covering admin authentication, category creation, photo uploads, search, pagination, byte-range serving, invalid file rejection, request-origin protection, deletion, and logout. The test starts a real application server with isolated temporary storage. npm reported zero dependency vulnerabilities at installation. Visual browser testing and deployment to Hostinger have not been performed. Configure your `.env` credentials before running `npm start`.
