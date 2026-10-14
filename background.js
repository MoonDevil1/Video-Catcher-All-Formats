'use strict';
const entries = new Map();
const mediaPattern = /\.(mp4|webm|mkv|mov|mp3|m4a|aac|ogg|opus|wav|flac|ts|m3u8|mpd)(?:$|[?#])/i;
function valid(url) { try { return ['http:', 'https:'].includes(new URL(url).protocol); } catch { return false; } }
function kind(url, mime='') { return (/\.m3u8|\.mpd|mpegurl|dash\+xml/i.test(url + mime)) ? 'stream' : 'file'; }
function fileName(url) { try { return (new URL(url).pathname.split('/').pop() || 'media').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0,100); } catch { return 'media'; } }
async function getList(id) {
  if(entries.has(id)) return entries.get(id);
  const result = await chrome.storage.session.get('tab_'+id);
  const list = result['tab_'+id] || [];
  entries.set(id,list); return list;
}
async function capture(id,url,mime='') {
  if(!Number.isInteger(id) || id < 0 || !valid(url)) return;
  if(!mediaPattern.test(url) && !/^(audio|video)\//i.test(mime) && !/mpegurl|dash\+xml/i.test(mime)) return;
  const list = await getList(id);
  if(list.some(item => item.url === url)) return;
  const ext = new URL(url).pathname.split('.').pop().slice(0,10).toUpperCase();
  list.unshift({url, name:fileName(url), ext, type:kind(url,mime)});
  if(list.length > 400) list.length = 400;
  await chrome.storage.session.set({['tab_'+id]:list});
  chrome.action.setBadgeText({tabId:id, text:String(list.length)}).catch(()=>{});
}
chrome.webRequest.onBeforeRequest.addListener(d => { if(d.tabId >= 0) capture(d.tabId,d.url); }, {urls:['<all_urls>'],types:['media','xmlhttprequest','other']});
chrome.webRequest.onHeadersReceived.addListener(d => {
  const mime = d.responseHeaders?.find(h => h.name.toLowerCase()==='content-type')?.value || '';
  if(d.tabId>=0 && (/^(audio|video)\//i.test(mime)||/mpegurl|dash\+xml/i.test(mime))) capture(d.tabId,d.url,mime);
}, {urls:['<all_urls>'],types:['media','xmlhttprequest','other']}, ['responseHeaders']);
chrome.tabs.onRemoved.addListener(id => { entries.delete(id); chrome.storage.session.remove('tab_'+id); });
chrome.runtime.onMessage.addListener((message,sender,reply) => {
  (async () => {
    const id = Number.isInteger(message.tabId) ? message.tabId : sender.tab?.id;
    if(!Number.isInteger(id)) return {error:'No tab found'};
    if(message.action==='found') {
      for(const u of (message.urls||[]).slice(0,100)) if(typeof u==='string') await capture(id,u);
      return {ok:true};
    }
    if(message.action==='list') return {items:await getList(id)};
    if(message.action==='clear') {
      entries.set(id,[]); await chrome.storage.session.remove('tab_'+id);
      await chrome.action.setBadgeText({tabId:id,text:''}).catch(()=>{});
      return {ok:true};
    }
    if(!valid(message.url) || !(await getList(id)).some(item=>item.url===message.url)) return {error:'Media not detected'};
    if(message.action==='download') {
      if(kind(message.url)!=='file') return {error:'Not a direct file'};
      const downloadId = await chrome.downloads.download({url:message.url,filename:'VideoCatcher/'+fileName(message.url),conflictAction:'uniquify'});
      return {ok:true,downloadId};
    }
    if(message.action==='openStream') {
      await chrome.tabs.create({url:chrome.runtime.getURL('downloader.html')+'?url='+encodeURIComponent(message.url)});
      return {ok:true};
    }
    return {error:'Unknown request'};
  })().then(reply).catch(e=>reply({error:String(e.message)}));
  return true;
});
