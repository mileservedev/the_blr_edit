import { test } from 'node:test';
import assert from 'node:assert/strict';
import config from '../lib/config.cjs';
const { readSupabaseConfig } = config;
const url = 'https://example.supabase.co';
const jwt = role => `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.test-signature`;

test('Supabase config accepts trimmed secret keys and legacy service_role keys', () => {
  assert.deepEqual(readSupabaseConfig({ SUPABASE_URL: ` "${url}/" `, SUPABASE_SECRET_KEY: ' "sb_secret_private-test" ' }), { url, key: 'sb_secret_private-test' });
  for (const name of ['SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
    assert.equal(readSupabaseConfig({ SUPABASE_URL: url, [name]: jwt('service_role') }).key, jwt('service_role'));
  }
});

test('Supabase config distinguishes invalid settings without disclosing values', () => {
  const cases = [
    [{}, /SUPABASE_URL is missing/],
    [{ SUPABASE_URL: url }, /SUPABASE_SECRET_KEY is missing/],
    [{ SUPABASE_URL: url, SUPABASE_SECRET_KEY: 'sb_publishable_private-test' }, /publishable/],
    [{ SUPABASE_URL: url, SUPABASE_SECRET_KEY: jwt('anon') }, /anon key/],
    [{ SUPABASE_URL: url, SUPABASE_SECRET_KEY: 'private-invalid-key' }, /unsupported format/],
    [{ SUPABASE_URL: url + '/rest/v1', SUPABASE_SECRET_KEY: 'sb_secret_private-test' }, /HTTPS project origin/],
  ];
  for (const [env, expected] of cases) {
    assert.throws(() => readSupabaseConfig(env), error => {
      assert.equal(error.code, 'SUPABASE_CONFIG');
      assert.match(error.message, expected);
      if (env.SUPABASE_SECRET_KEY) assert.ok(!error.message.includes(env.SUPABASE_SECRET_KEY));
      assert.ok(!error.message.includes(url));
      return true;
    });
  }
});
