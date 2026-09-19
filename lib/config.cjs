'use strict';

function clean(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) return text.slice(1, -1).trim();
  return text;
}
function configError(message) {
  return Object.assign(new Error(message), { code: 'SUPABASE_CONFIG' });
}
function readSupabaseConfig(env) {
  const url = clean(env.SUPABASE_URL);
  const key = clean(env.SUPABASE_SECRET_KEY) || clean(env.SUPABASE_SERVICE_ROLE_KEY);
  if (!url) throw configError('SUPABASE_URL is missing or empty in the running Node process. Save it in Hostinger environment settings and restart.');
  if (!key) throw configError('SUPABASE_SECRET_KEY is missing or empty in the running Node process. SUPABASE_SERVICE_ROLE_KEY is also accepted for a legacy service_role key. Save the setting and restart.');
  if (key.includes('replace-')) throw configError('The Supabase server key is still a placeholder. Replace it in Hostinger and restart.');
  if (key.startsWith('sb_publishable_')) throw configError('The configured Supabase key is publishable. This server requires a secret key or a legacy service_role key.');
  let legacyRole;
  if (key.split('.').length === 3) {
    try { legacyRole = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString('utf8')).role; } catch {}
  }
  if (!key.startsWith('sb_secret_') && legacyRole !== 'service_role') {
    throw configError(legacyRole === 'anon'
      ? 'The configured Supabase key is an anon key. Use the secret or legacy service_role key.'
      : 'The configured Supabase key has an unsupported format. Use sb_secret_... or the legacy service_role JWT.');
  }
  // Decoding a legacy role only checks format; Supabase verifies the key remotely.
  let parsed;
  try { parsed = new URL(url); } catch { throw configError('SUPABASE_URL is not a valid URL. Copy the HTTPS Project URL from Supabase.'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw configError('SUPABASE_URL must be the HTTPS project origin, without an API path, query, or credentials.');
  }
  return { url: parsed.origin, key };
}
module.exports = { readSupabaseConfig };
