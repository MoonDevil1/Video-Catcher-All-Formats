const MAX_ITEMS_PER_TAB = 400;
const FILE_EXT = /\.(mp4|m4v|webm|mkv|mov|mp3|m4a|aac|ogg|oga|opus|wav|flac|ts)(?:$|[?#])/i;
const STREAM_EXT = /\.(m3u8|mpd)(?:$|[?#])/i;
const MIME_RE = /^(video\/|audio\/|application\/(?:vnd\.apple\.mpegurl|x-mpegurl|dash\+xml|mp4|octet-stream))/i;
const cache = new Map();

function valid(url) {
  try { const u = new URL(url); return ['http:', 'https:'].includes(u.protocol) && url.length < 6000; }
  catch { return false; }
}
function classify(url, mime = '') {
  if (STREAM_EXT.test(url) || /mpegurl|dash\+xml/i.test(mime)) return 'stream';
  if (FILE_EXT.test(url) || /^(video\/|audio\/)/i.test(mime)) return 'file';
  return null;
}
function extension(url) {
  try { const path = new URL(url).pathname; return (path.split('.').pop() || '').slice(0, 8).toUpperCase(); }
  catch { return ''; }
}
function filename(url) {
  try {
    const part = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'media');
    return (part.replace(/[\\/:*?"<>|\x00-\x1F]/g, '_').slice(0, 100) || 'media');
  } catch { return 'media'; }
}
async function load(tabId) {
  if (cache.has(tabId)) return cache.get(tabId);
  const key = 'tab_' + tabId;
  const data = await chrome.storage.session.get(key);
  const rows = Array.isArray(data[key]) ? data[key] : [];
  cache.set(tabId, rows);
  return rows;
}
async function add(tabId, url, source = 'network', mime = '', quality = '') {
  if (!(tabId >= 0) || !valid(url)) return;
  const type = classify(url, mime);
  if (!type) return;
  const rows = await load(tabId);
  if (rows.some(x => x.url === url)) return;
  rows.unshift({ url, type, source, mime: mime.slice(0, 90), quality, ext: extension(url), name: filename(url), title: '', confirmed: false, playing: false, height: 0, time: Date.now(), playedMs: 0, adLikely: false, duration: 0, playerId: null, superseded: false, lastActive: 0 });
  if (rows.length > MAX_ITEMS_PER_TAB) rows.length = MAX_ITEMS_PER_TAB;
  await chrome.storage.session.set({['tab_' + tabId]: rows});
  await chrome.action.setBadgeText({tabId, text: String(rows.length)}).catch(() => {});
  await chrome.action.setBadgeBackgroundColor({tabId, color: '#8b5cf6'}).catch(() => {});
}
chrome.webRequest.onBeforeRequest.addListener(details => {
  if (details.tabId >= 0) void add(details.tabId, details.url, 'network');
}, { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other'] });
chrome.webRequest.onHeadersReceived.addListener(details => {
  if (details.tabId < 0) return;
  const type = details.responseHeaders?.find(h => h.name.toLowerCase() === 'content-type')?.value || '';
  if (MIME_RE.test(type) && !/octet-stream/i.test(type)) void add(details.tabId, details.url, 'response', type);
}, { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other'] }, ['responseHeaders']);
function itemTitle(item){if(!item?.title)return '';const suffix=(new URL(item.url).pathname.match(/\.[a-zA-Z0-9]{2,5}$/)||[])[0]||'';return item.title.replace(/[\\/:*?"<>|\x00-\x1F]/g,'_').slice(0,100)+suffix}
chrome.runtime.onMessage.addListener((msg, sender, send) => {
  (async () => {
    const id = Number.isInteger(msg.tabId) ? msg.tabId : sender.tab?.id;
    if (!Number.isInteger(id)) return {error: 'No browser tab'};
    if (msg.action === 'playback') {
      for (const entry of (msg.records || []).slice(0, 60)) {
        if (!entry?.url || typeof entry.url !== 'string') continue;
        await add(id, entry.url, 'player');
        const rows = await load(id), item = rows.find(x => x.url === entry.url);
        if (item) { item.title = String(entry.title || item.title || '').replace(/[\\/:*?"<>|\x00-\x1F]/g, '_').slice(0, 120); item.playedMs = Math.max(item.playedMs || 0, Number(entry.playedMs)||0); item.duration = Number(entry.duration)||0; item.adLikely = item.userChoice==='ad' || (item.userChoice!=='main' && (Boolean(entry.adHint) || (item.duration>0 && item.duration<35 && item.playedMs<15000))); item.confirmed = item.playedMs>=8000 && !item.adLikely; item.playing = Boolean(entry.playing); item.height = Number(entry.height) || 0; item.playerId = Number(entry.playerId) || null; if(item.playing) item.lastActive=Date.now(); if(item.playerId && item.playing && item.confirmed && item.userChoice!=='ad') {for(const prior of rows){if(prior!==item && prior.playerId===item.playerId){if(prior.userChoice!=='main'){prior.playing=false;prior.superseded=true;}}}} await chrome.storage.session.set({['tab_' + id]: rows}); }
      }
      for (const url of (msg.urls || []).slice(0, 60)) if (typeof url === 'string') await add(id, url, 'page');
      return {ok: true};
    }
    if (msg.action === 'found') {
      for (const entry of (Array.isArray(msg.urls) ? msg.urls.slice(0, 100) : [])) {
        if (typeof entry === 'string') await add(id, entry, 'page');
        else if (entry?.url) await add(id, entry.url, 'page', '', String(entry.quality || '').slice(0, 32));
      }
      return {ok: true};
    }
    if (msg.action === 'list') return {items: await load(id)};
    if (msg.action === 'markMain' || msg.action === 'markAd') {
      const rows=await load(id), target=rows.find(x=>x.url===msg.url);
      if(!target)return {error:'Media not found in this tab'};
      if(msg.action==='markMain'){
        target.userChoice='main';target.adLikely=false;target.superseded=false;
        for(const other of rows)if(other!==target&&other.playerId&&other.playerId===target.playerId)other.userChoice='ad';
      }else target.userChoice='ad';
      await chrome.storage.session.set({['tab_'+id]:rows});return {ok:true};
    }

    if (msg.action === 'clear') {
      cache.set(id, []);
      await chrome.storage.session.remove('tab_' + id);
      await chrome.action.setBadgeText({tabId: id, text: ''}).catch(() => {});
      return {ok: true};
    }
    if (msg.action === 'openStream') {
      if (!valid(msg.url) || !((await load(id)).some(x => x.url === msg.url && x.type === 'stream'))) return {error: 'Stream was not detected in this tab.'};
      const chosen = (await load(id)).find(x => x.url === msg.url);
      const page = chrome.runtime.getURL('downloader.html') + '?url=' + encodeURIComponent(msg.url) + '&title=' + encodeURIComponent(chosen?.title || 'Video Catcher');
      await chrome.tabs.create({url: page});
      return {ok: true};
    }
    if (msg.action === 'download') {
      if (!valid(msg.url) || classify(msg.url) !== 'file' || !((await load(id)).some(x => x.url === msg.url && x.type === 'file'))) return {error: 'Only direct media files can be downloaded; copy streaming manifest URLs instead.'};
      const item=(await load(id)).find(x=>x.url===msg.url);const filenameChoice='VideoCatcher/' + (itemTitle(item) || filename(msg.url));
      const downloadId = await chrome.downloads.download({url:msg.url,filename:filenameChoice,conflictAction:'uniquify',saveAs:false});
      const history=(await chrome.storage.local.get({downloadHistory:[]})).downloadHistory;
      history.unshift({id:downloadId,title:item.title||item.name||'Media',format:item.ext||'SOURCE',date:Date.now(),filename:filenameChoice});
      await chrome.storage.local.set({downloadHistory:history.slice(0,100)});
      return {ok:true,downloadId};
    }
    return {error: 'Unknown action'};
  })().then(send).catch(e => send({error: e?.message || 'Unexpected error'}));
  return true;
});
chrome.tabs.onRemoved.addListener(id => {
  cache.delete(id);
  void chrome.storage.session.remove('tab_' + id);
});
chrome.tabs.onUpdated.addListener((id, change) => {
  if (change.status === 'loading' && change.url) {
    cache.delete(id);
    void chrome.storage.session.remove('tab_' + id);
    void chrome.action.setBadgeText({tabId: id, text: ''}).catch(() => {});
  }
});
