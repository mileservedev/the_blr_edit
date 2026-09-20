# The BLR Edit

The website companion to [@the.blr.edit](https://www.instagram.com/the.blr.edit/), focused on Bangalore food, experiences and lifestyle. Includes an admin area, searchable discoveries, nine-item pagination, and a responsive gold, black and white design. Instagram references are profile links; content is managed through the admin area, not automatically imported.

## Storage architecture

Hostinger runs the Express application. Supabase PostgreSQL stores categories, media records and admin sessions. Supabase Storage holds the original photos/videos in a public `gallery` bucket. The browser loads media directly from Supabase; no permanent data is stored on Hostinger. Uploads use the operating system's temporary directory during file validation/transfer and are removed afterward. No paid services or upgrades are enabled by this code.

The public gallery starts empty. Admin credentials remain environment variables; you do not need to create a Supabase Auth user. All published media is public. Only the Node server holds the Supabase secret key. RLS and grants deny direct table/function access to anonymous and authenticated Supabase clients. Use a dedicated Supabase project; do not add browser write policies to this bucket.

## 1. Create your free Supabase project

1. Sign in at https://supabase.com/dashboard and create a project in a **Free** organization. Choose a nearby available region, such as Mumbai. Save the project's database password privately.
2. Wait until the project is ready. Open **SQL Editor → New query**.
3. Paste the entire contents of [`supabase/setup.sql`](supabase/setup.sql), then click **Run**. This creates three tables, search functions, permissions and the public `gallery` bucket with a 50 MB limit. It is safe to rerun without deleting collection data.
4. Find the **Project URL** in the Connect dialog or project API settings; it looks like `https://PROJECT_REF.supabase.co`.
5. Under **Settings → API Keys**, copy or create a **secret key** starting with `sb_secret_`. Set this as `SUPABASE_SECRET_KEY` on the server. A legacy `service_role` JWT is also accepted under `SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY`. Do not use a publishable/anon key. Do not put a secret key in source code, browser JavaScript, GitHub, screenshots, or chat messages.

This app uses the Supabase HTTPS APIs; a PostgreSQL connection URL or database password is not required in Hostinger.

## 2. Configure Hostinger

Use your existing Node.js website for `mileserve.in`, connected to GitHub repository `mileservedev/the_blr_edit`, branch `main`. Configure Supabase and the required environment variables before deploying.

| Setting | Value |
|---|---|
| Framework | Express |
| Node version | 24 |
| Root | Repository root |
| Install command (if asked) | `npm ci` |
| Build command | `npm run build` |
| Start command | `npm start` |
| Entry file | `app.js` (Hostinger Express default) |

No frontend build output directory is generated. In hPanel's Environment Variables, add:

```dotenv
NODE_ENV=production
PORT=3000
ADMIN_EMAIL=your-email@example.com
ADMIN_PASSWORD=your-unique-password-at-least-12-characters
SESSION_SECRET=your-random-secret-at-least-32-characters
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_SECRET_KEY=sb_secret_YOUR_SECRET_KEY
TRUST_PROXY=0
```

Replace the example values. Generate `SESSION_SECRET` locally with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Set `TRUST_PROXY=1` only if Hostinger confirms that exactly one trusted reverse proxy is in front of the app. This controls the client IP used for login rate limiting. Remove old `DATA_DIR`, `UPLOAD_DIR`, and `MAX_UPLOAD_MB` settings; they are no longer used. The upload cap is fixed at 50,000,000 bytes for this free-plan configuration. Ensure Hostinger accepts requests slightly larger than 50 MB (multipart overhead) and allows time for the storage transfer.

Run the SQL setup before deploying. The CommonJS app.js entry loads server.js, which calls Node HTTP listen() synchronously for Hostinger, then loads the ES-module app and checks Supabase in the background. Until ready, requests receive HTTP 503 with a Retry-After header. Failed Supabase checks retry every 30 seconds; invalid environment settings require a restart after correction. Redeploy, enable HTTPS, then visit `https://mileserve.in/admin`. Sign in using your `ADMIN_EMAIL` and `ADMIN_PASSWORD`, create a category, and upload a photo/video. Restart or redeploy once and confirm the content persists.

## Free-plan limits and operation

- Maximum file size: **50 MB**. Enforced in the browser, Express, and the bucket.
- Total file storage: **1 GB** on Supabase Free; monitor usage in the Supabase dashboard.
- Database allowance: **500 MB**.
- Monthly transfer: **5 GB uncached + 5 GB cached**. Repeated video playback consumes this allowance.
- Free projects can pause after **one week of inactivity**. Resume a paused project in Supabase; if the app failed startup while paused, restart it in Hostinger afterward.
- Free does not include automatic database backups. Export your database and keep copies of original media separately.

These are plan allowances, not additional per-project guarantees made by the app. Supabase enforces account/plan quotas. See https://supabase.com/pricing for current limits. The code does not upgrade your plan or purchase capacity.

Supported files: JPEG, PNG, WebP, MP4 and WebM. Actual file signatures are checked. H.264/AAC MP4 provides broad browser playback support. No video transcoding or poster generation is included. Uploads are standard, non-resumable transfers; a failed transfer must be retried. One upload is processed at a time per Node process to bound memory use. The progress indicator reports browser-to-Hostinger progress, then shows “Saving to collection…” during the Supabase transfer.

A definitive database rejection after upload triggers object cleanup. On an uncertain network failure, the object is retained to avoid deleting a potentially committed media record; check runtime logs for its generated filename and reconcile it with the `media` table in Supabase. Interrupted transfers can also leave orphaned objects. Deletion removes storage first and retains the metadata on storage failure so it can be retried. Public media may remain cached briefly after deletion.

Admin sessions last eight hours and persist across restarts. Cookies are HttpOnly/SameSite, and Secure in production. Login attempts are rate-limited. Rotate `SESSION_SECRET` and restart to invalidate all existing cookies. Expired session rows are removed on the next successful login.

## Local development and checks

Requires Node 22.13+; Node 24 is recommended. Complete the Supabase setup above, copy `.env.example` to `.env`, and fill in your own values privately.

```bash
npm ci
npm run build
npm test
npm start
```

Visit http://localhost:3000 or http://localhost:3000/admin. Keep `NODE_ENV=development` locally so cookies work over HTTP.

Tests use a local HTTP fixture backed by PGlite (PostgreSQL), exercising the real Supabase SDK and actual setup SQL. They check schema reruns, table/function permissions, login, category creation, uploads, search, pagination, public media URLs, upload-size limits, failure cleanup, deletion, and persistence across an application restart. They do not require or modify a real Supabase project. The fixture emulates Supabase REST/Storage; a final live project upload/playback test is still required after credentials are configured.

## Existing local content

This change does not automatically migrate a previous SQLite database or local uploads. Existing local `data/` and `uploads/` files are left untouched. If you already uploaded real content with the earlier version, keep a backup and migrate/re-upload it before switching production traffic. Never put those files in GitHub.

## Deployment references

- Hostinger Node deployment: https://www.hostinger.com/support/how-to-deploy-a-nodejs-website-in-hostinger/
- Supabase API keys: https://supabase.com/docs/guides/getting-started/api-keys
- Supabase storage: https://supabase.com/docs/guides/storage/uploads/standard-uploads


## Upload dates, likes, and optional social links

Cards and the viewer show upload dates. Visitors can like content using a signed browser cookie.

Every opening displays the uploaded media locally, including repeat views. Add an optional Instagram link during upload or on an existing admin card to show Watch on Instagram on the card and in the viewer. The link opens a new tab only when clicked. If Instagram is absent, a provided YouTube link shows Watch on YouTube instead.

YouTube supports HTTPS watch, Shorts, live, embed and youtu.be video links. Editing one link through the API preserves the other. Existing engagement data remains intact. This change needs no SQL migration or new environment variables.

## Cafe discoveries with multiple photos

Run the updated `supabase/setup.sql` before deploying this feature. It adds description and photos fields without deleting existing content. Upload one main video or photo and up to eight additional JPEG, PNG or WebP photos, with a combined limit of 50 MB. Add up to 2,000 characters describing the place or experience. The viewer displays the main media, description and additional photos together. Admin cards allow editing descriptions on existing posts. Deleting a discovery removes its main file and all additional photos.
