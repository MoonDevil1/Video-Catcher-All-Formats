const list = document.querySelector('#items');
let preferredQuality='highest';
function chooseVariantIndex(variants){const available=variants.map((v,i)=>({i,h:parseInt((v.quality||v.name||v.url||'').match(/(?:2160|1440|1080|720|480|360|240)p?/i)?.[0]||'0',10)||0})).sort((a,b)=>b.h-a.h);if(!available.length)return 0;if(preferredQuality==='highest')return available[0].i;const target=Number(preferredQuality);return (available.find(v=>v.h&&v.h<=target)||available[available.length-1]).i;}

const count = document.querySelector('#count');
const status = document.querySelector('#status');
let tabId;
const send = msg => chrome.runtime.sendMessage({...msg, tabId});
function showStatus(s) { status.textContent = s; }
function button(label, onClick, primary = false) { const b=document.createElement('button'); b.textContent=label; if(primary)b.className='primary'; b.addEventListener('click',onClick); return b; }
function quality(item) { const match = (item.quality || item.name || item.url).match(/(?:^|[^0-9])(2160|1440|1080|720|480|360|240)p?(?:[^0-9]|$)/i); return item.quality || (match ? match[1]+'p' : 'Original / unknown'); }
function fileFormat(item) { const e=(item.ext||'').toUpperCase(); return e && /^[A-Z0-9]{2,8}$/.test(e) ? e : (item.mime.split('/')[1] || 'SOURCE').toUpperCase(); }
function selector(label, options) { const field=document.createElement('div');field.className='field';const lab=document.createElement('label');lab.textContent=label;const sel=document.createElement('select');for(const [value,caption] of options){const opt=document.createElement('option');opt.value=value;opt.textContent=caption;sel.append(opt);}field.append(lab,sel);return {field,sel}; }
let allItems = [];
function render(items) {
  allItems = items;
  const format=document.querySelector('#format').value;
  items=items.filter(x=>format==='all'||(format==='stream'?x.type==='stream':format==='audio'?/^(MP3|M4A|AAC|WAV|OGG|FLAC)$/.test(x.ext):x.type==='file'&&!/^(MP3|M4A|AAC|WAV|OGG|FLAC)$/.test(x.ext)));
  if(!document.querySelector('#showall').checked){const confirmed=items.filter(x=>x.userChoice==='main'||(x.confirmed&&!x.adLikely&&!x.superseded&&x.userChoice!=='ad'));items=confirmed.length?confirmed:items.filter(x=>x.userChoice!=='ad'&&!x.adLikely&&!x.superseded&&x.type==='stream')}
  items.sort((a,b)=>Number(b.playing&&b.confirmed)-Number(a.playing&&a.confirmed)||Number(b.confirmed)-Number(a.confirmed)||Number(b.playing&&b.confirmed)-Number(a.playing&&a.confirmed)||(b.playedMs||0)-(a.playedMs||0));
  count.textContent=`${items.length} media link${items.length===1?'':'s'}`;
  list.replaceChildren();
  if(!items.length){const e=document.createElement('div');e.className='empty';e.textContent='No media detected yet. Play a video on this page, then click Refresh.';list.append(e);return;}
  // Only group variants when their filenames differ solely by an obvious quality marker.
  const groups=new Map();
  const keyFor=x=>{try{const u=new URL(x.url);const base=u.pathname.toLowerCase().replace(/(?:2160|1440|1080|720|480|360|240)p(?=\.|[-_])/g,'QUALITY').replace(/[-_](?:2160|1440|1080|720|480|360|240)(?=\.|[-_])/g,'_QUALITY');return x.type+'|'+u.origin+base;}catch{return x.url;}};
  for(const x of items){const key=keyFor(x);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(x);}
  for(const variants of groups.values()) {
    const item=variants.find(x=>x.userChoice==='main')||variants[0];const wrap=document.createElement('section');wrap.className='item';
    const top=document.createElement('div');top.className='top';const tag=document.createElement('span');tag.className='type';tag.textContent=item.type==='stream'?'HLS / DASH':fileFormat(item);const name=document.createElement('span');name.className='name';name.textContent=item.title||item.name||'media';name.title=name.textContent;top.append(tag,name);if(item.confirmed){const active=document.createElement('span');active.className='active';active.textContent=item.playing?'▶ Playing':(item.height?item.height+'p':'In video player');top.append(active)}
    const qualityOptions=variants.map((x,i)=>[String(i),quality(x)]);
    const q=selector('Detected quality',qualityOptions);
    const formatOptions=[...new Set(variants.map(fileFormat))].map(f=>[f,f+' (original)']);
    const f=selector('Available format',formatOptions);
    const sync=()=>{const filtered=variants.map((x,i)=>({x,i})).filter(v=>fileFormat(v.x)===f.sel.value);q.sel.replaceChildren();for(const v of filtered){const o=document.createElement('option');o.value=String(v.i);o.textContent=quality(v.x);q.sel.append(o);}};
    f.sel.addEventListener('change',sync);sync();const preferred=String(chooseVariantIndex(variants));if([...q.sel.options].some(x=>x.value===preferred))q.sel.value=preferred;
    const sels=document.createElement('div');sels.className='selectors';sels.append(q.field,f.field);
    const url=document.createElement('div');url.className='url';
    const selected=()=>variants[Number(q.sel.value)] || item;
    const updateURL=()=>{url.textContent=selected().url;url.title=selected().url;};q.sel.addEventListener('change',updateURL);f.sel.addEventListener('change',updateURL);updateURL();
    const actions=document.createElement('div');actions.className='actions';
    if(item.type==='file')actions.append(button('⬇ Download Media',async()=>{try{const r=await send({action:'download',url:selected().url});showStatus(r.error || 'Original media download started. Audio is not re-encoded.');}catch(e){showStatus(e.message);}},true));
    if(item.type==='stream')actions.append(button('⬇ Download HLS',async()=>{try{const r=await send({action:'openStream',url:selected().url});showStatus(r.error || 'Opened HLS downloader.');}catch(e){showStatus(e.message);}},true));
    actions.append(button('✓ Main video',async()=>{const r=await send({action:'markMain',url:selected().url});showStatus(r.error||'Marked as main video for this tab.');await refresh();}));
    actions.append(button('Not main / Ad',async()=>{const r=await send({action:'markAd',url:selected().url});showStatus(r.error||'Hidden from main-video results.');await refresh();}));
    actions.append(button('Copy URL',async()=>{try{await navigator.clipboard.writeText(selected().url);showStatus(item.type==='stream'?'Stream manifest URL copied (not downloaded).':'Media URL copied.');}catch{showStatus('Clipboard access failed.');}}));
    if(item.type==='stream'){const note=document.createElement('div');note.className='hint';note.style.padding='6px 0 0';note.textContent='HLS VOD playlists: select quality in the downloader; unsupported DASH, encrypted, or split-track streams can only be copied.';wrap.append(top,sels,url,actions,note);}else wrap.append(top,sels,url,actions);
    list.append(wrap);
  }
}
async function refresh(){if(tabId===undefined)return;try{const r=await send({action:'list'});render(r.items||[]);}catch(e){showStatus(e.message);}}
document.querySelector('#refresh').addEventListener('click',refresh);
document.querySelector('#clear').addEventListener('click',async()=>{await send({action:'clear'});refresh();});
(async()=>{const [tab]=await chrome.tabs.query({active:true,currentWindow:true});tabId=tab?.id;if(tabId===undefined){showStatus('No tab selected.');return;}await refresh();})();

document.querySelector('#showall').addEventListener('change',()=>render(allItems));document.querySelector('#format').addEventListener('change',()=>render(allItems));

(async()=>{const settings=await chrome.storage.local.get({preferredQuality:'highest',preferOriginalAudio:true});preferredQuality=settings.preferredQuality;document.querySelector('#prefquality').value=preferredQuality;document.querySelector('#prefaudio').checked=settings.preferOriginalAudio;document.querySelector('#prefquality').addEventListener('change',async e=>{preferredQuality=e.target.value;await chrome.storage.local.set({preferredQuality});render(allItems)});document.querySelector('#prefaudio').addEventListener('change',e=>chrome.storage.local.set({preferOriginalAudio:e.target.checked}));render(allItems)})();

async function showHistory(){const {downloadHistory=[]}=await chrome.storage.local.get({downloadHistory:[]});const box=document.querySelector('#history');box.replaceChildren();const h=document.createElement('h3');h.textContent='Recent downloads';box.append(h);if(!downloadHistory.length){const p=document.createElement('p');p.textContent='No direct-file downloads recorded yet.';box.append(p)}for(const job of downloadHistory.slice(0,12)){const item=document.createElement('p');item.textContent=`${new Date(job.date).toLocaleString()} · ${job.title} · ${job.format}`;box.append(item)}}
document.querySelector('#historyToggle').addEventListener('click',()=>{const box=document.querySelector('#history');box.hidden=!box.hidden;if(!box.hidden)showHistory()});
