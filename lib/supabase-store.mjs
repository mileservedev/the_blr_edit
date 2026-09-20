import { createClient } from '@supabase/supabase-js';
import { readFile } from 'node:fs/promises';

export function createSupabaseStore(url, key) {
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (url, init = {}) => fetch(url, { ...init, signal: init.signal || AbortSignal.timeout(120000) }) },
  });
  const bucket = client.storage.from('gallery');
  async function result(query) {
    const { data, error } = await query;
    if (error) throw error;
    return data;
  }
  return {
    mediaOrigin: new URL(url).origin,
    async check() {
      await result(client.from('sessions').select('token').limit(0));
      await result(client.rpc('gallery_categories'));
      await result(client.from('media').select('instagram_url,youtube_url,description,photos').limit(0));
      await result(client.rpc('gallery_engagement', { item_ids: [], browser_id: '0'.repeat(64) }));
      const info = await result(client.storage.getBucket('gallery'));
      if (!info.public || Number(info.file_size_limit) !== 50000000) {
        throw new Error('Run supabase/setup.sql to configure the public gallery bucket and 50 MB limit.');
      }
    },
    categories: () => result(client.rpc('gallery_categories')),
    addCategory: name => result(client.from('categories').insert({ name }).select('id,name').single()),
    category: id => result(client.from('categories').select('id').eq('id', id).maybeSingle()),
    deleteCategory: id => result(client.from('categories').delete().eq('id', id)),
    search: async (filters, visitor) => {
      const data = await result(client.rpc('gallery_search', filters));
      const engagement = await result(client.rpc('gallery_engagement', { item_ids: data.items.map(m => m.id), browser_id: visitor }));
      return { ...data, items: data.items.map(item => ({ ...item, photos: (item.photos || []).map(filename => ({ filename, url: bucket.getPublicUrl(filename).data.publicUrl })), ...engagement.find(e => e.media_id === item.id), url: bucket.getPublicUrl(item.filename).data.publicUrl })) };
    },
    like: (id, visitor, liked) => result(client.rpc('gallery_like', { item_id: id, browser_id: visitor, desired_like: liked })),
    open: (id, visitor) => result(client.rpc('gallery_open', { item_id: id, browser_id: visitor })),
    setLinks: (id, links) => result(client.from('media').update(links).eq('id', id).select('id,instagram_url,youtube_url').maybeSingle()),
    addMedia: item => result(client.from('media').insert(item).select('id').single()),
    media: id => result(client.from('media').select('*').eq('id', id).maybeSingle()),
    deleteMedia: id => result(client.from('media').delete().eq('id', id)),
    async upload(filename, filePath, contentType) {
      // Only one upload is allowed in flight per server process, bounding RAM use.
      const bytes = await readFile(filePath);
      await result(bucket.upload(filename, bytes, { contentType, cacheControl: '3600', upsert: false }));
    },
    removeFile: filename => result(bucket.remove([filename])),
    session: token => result(client.from('sessions').select('token').eq('token', token).gt('expires', Date.now()).maybeSingle()),
    async addSession(token, expires) {
      await result(client.from('sessions').delete().lte('expires', Date.now()));
      await result(client.from('sessions').insert({ token, expires }));
    },
    deleteSession: token => result(client.from('sessions').delete().eq('token', token)),
  };
}
