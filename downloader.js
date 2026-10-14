"use strict";
// Local processing only. No server, telemetry, DRM bypass or native executable.
const $ = id => document.getElementById(id);
const state = {variants:[], audioRenditions:[], cancel:false, busy:false};
const pageArgs = new URL(location.href).searchParams;
const source = pageArgs.get('url');
const displayTitle = (pageArgs.get('title') || 'Video Catcher').replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').slice(0,95);
function remote(url) { const p = new URL(url); if (!['https:','http:'].includes(p.protocol)) throw Error('Unsupported URL scheme'); return url; }
function abs(text,base) { return remote(new URL(text.trim().replace(/^"|"$/g,''),base).href); }
function attrs(line) { const o={}; const s=line.replace(/^#EXT-X-STREAM-INF:/,''); const re=/([\w-]+)=("[^"]*"|[^,]*)/g; let m; while((m=re.exec(s)))o[m[1]]=m[2].replace(/^"|"$/g,''); return o; }
async function fetchText(url) {const r=await fetch(remote(url),{credentials:'include'});if(!r.ok)throw Error(`Playlist HTTP ${r.status}`);return r.text();}
async function openPlaylist(url) {
  const text=await fetchText(url);if(!text.startsWith('#EXTM3U'))throw Error('Not a valid HLS playlist');
  const lines=text.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  // Track declared audio renditions instead of silently dropping their existence.
  state.audioRenditions=[];
  for(const line of lines){
    if(!line.startsWith('#EXT-X-MEDIA:'))continue;
    const a=attrs(line.replace('#EXT-X-MEDIA:','#EXT-X-STREAM-INF:'));
    if(a.TYPE==='AUDIO'&&a.URI){state.audioRenditions.push({group:a['GROUP-ID']||'',name:a.NAME||a.LANGUAGE||'Audio',language:a.LANGUAGE||'',url:abs(a.URI,url)});}
  }
  if(lines.some(l=>l.startsWith('#EXT-X-STREAM-INF:'))){
    const options=[];
    for(let i=0;i<lines.length;i++)if(lines[i].startsWith('#EXT-X-STREAM-INF:')){
      const at=attrs(lines[i]);let j=i+1;while(j<lines.length&&lines[j].startsWith('#'))j++;
      if(j<lines.length){const height=at.RESOLUTION?.split('x')[1];options.push({url:abs(lines[j],url),height:Number(height)||0,bandwidth:Number(at.BANDWIDTH)||0,audioGroup:at.AUDIO||'',label:(height?height+'p':at.BANDWIDTH?Math.round(Number(at.BANDWIDTH)/1000)+' kbps':'Variant')+(at.CODECS?' · '+at.CODECS:'')});}
    }
    if(!options.length)throw Error('No video variants found');return options.sort((a,b)=>b.height-a.height||b.bandwidth-a.bandwidth);
  }
  return [{url,label:'Original · source playlist'}];
}
function parseMedia(text,url){
  const lines=text.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  if(!lines.includes('#EXT-X-ENDLIST'))throw Error('Only finished on-demand playlists are supported (live streams are not).');
  if(lines.some(s=>s.startsWith('#EXT-X-KEY:')&&!/METHOD=NONE(?:,|$)/.test(s)))throw Error('Encrypted HLS is not supported.');
  if(lines.some(s=>s.startsWith('#EXT-X-BYTERANGE')||s.startsWith('#EXT-X-I-FRAMES-ONLY')||s.startsWith('#EXT-X-DISCONTINUITY')))throw Error('Byte-range, discontinuous, or iframe-only playlists are not supported.');
  const map=lines.find(s=>s.startsWith('#EXT-X-MAP:'));
  const mapMatch=map?.match(/URI="([^"]+)"/);
  if(map && (!mapMatch||/BYTERANGE=/.test(map)))throw Error('Unsupported segment map.');
  const segments=lines.filter(s=>!s.startsWith('#')).map(s=>abs(s,url));
  if(!segments.length)throw Error('Playlist has no media segments');
  if(segments.length>5000)throw Error('Playlist exceeds the 5000-segment safety limit');
  return {segments,init:mapMatch?abs(mapMatch[1],url):null, type:mapMatch?'mp4':'ts'};
}

// MPEG-DASH: limited support for clear, static SegmentList MPDs with explicit media URLs.
// Never attempt decryption or fabricate a playable file from unsupported segment templates.
const dashState={tracks:[]};
function dashChildren(parent,local){return [...parent.children].filter(n=>n.localName===local)}
function dashFirst(parent,local){return dashChildren(parent,local)[0]}
function parseDash(xml,manifestUrl){
 const doc=new DOMParser().parseFromString(xml,'application/xml');
 if(doc.querySelector('parsererror'))throw Error('Invalid MPEG-DASH XML');
 const mpd=doc.documentElement;
 if(mpd.localName!=='MPD'||mpd.getAttribute('type')==='dynamic')throw Error('Only static DASH MPDs are supported');
 if(doc.getElementsByTagNameNS('*','ContentProtection').length||doc.querySelector('ContentProtection'))throw Error('Encrypted/protected DASH content is not supported');
 const periods=dashChildren(mpd,'Period');if(periods.length!==1)throw Error('DASH multi-period manifests are not supported');
 const period=periods[0];let tracks=[];
 const appendBase=(node,base)=>{const b=dashFirst(node,'BaseURL');return b?abs(b.textContent,base):base};
 const mpdBase=appendBase(mpd,manifestUrl), periodBase=appendBase(period,mpdBase);
 for(const adaptation of dashChildren(period,'AdaptationSet')){
  const type=(adaptation.getAttribute('contentType')||adaptation.getAttribute('mimeType')||'').toLowerCase();
  const base=appendBase(adaptation,periodBase);
  for(const rep of dashChildren(adaptation,'Representation')){
   const mime=(rep.getAttribute('mimeType')||adaptation.getAttribute('mimeType')||'').toLowerCase();
   const mode=type||mime;
   if(!/video|audio/.test(mode))continue;
   const list=dashFirst(rep,'SegmentList')||dashFirst(adaptation,'SegmentList');
   const templ=dashFirst(rep,'SegmentTemplate')||dashFirst(adaptation,'SegmentTemplate');
   if(!list && !templ)continue;
   // Static SegmentTemplate with fixed duration, $Number$ and optional zero-padding.
   if(templ && !list){
    const media=templ.getAttribute('media'),initText=templ.getAttribute('initialization');
    const periodDuration=period.getAttribute('duration')||mpd.getAttribute('mediaPresentationDuration');
    const iso=/^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(periodDuration||'');
    const seconds=iso?(Number(iso[1]||0)*3600+Number(iso[2]||0)*60+Number(iso[3]||0)):0;
    const tick=Number(templ.getAttribute('timescale')||1),duration=Number(templ.getAttribute('duration')||0);
    const times=dashFirst(templ,'SegmentTimeline');
    if(!media || !seconds || !duration || !Number.isFinite(tick) || !Number.isFinite(duration) || tick<=0 || duration<=0 || times)continue;
    const count=Math.ceil(seconds*tick/duration),start=Number(templ.getAttribute('startNumber')||1);
    if(count<1||count>5000||!Number.isSafeInteger(start))continue;
    const repId=rep.getAttribute('id')||'',bw=rep.getAttribute('bandwidth')||'';
    const subst=(pattern,n)=>pattern.replace(/\$RepresentationID\$/g,repId).replace(/\$Bandwidth\$/g,bw).replace(/\$Number(?:%0(\d+)d)?\$/g,(_,w)=>w?String(n).padStart(Math.min(16,+w),'0'):String(n));
    if(!/\$Number(?:%0\d+d)?\$/.test(media))continue;
    const root=appendBase(rep,base),segments=Array.from({length:count},(_,i)=>abs(subst(media,start+i),root));
    const init=initText?abs(subst(initText,start),root):null;
    const height=Number(rep.getAttribute('height')||0),bitrate=Number(rep.getAttribute('bandwidth')||0);
    tracks.push({url:manifestUrl,kind:/audio/.test(mode)?'audio':'video',height,bitrate,mime,segments,init,label:[height?height+'p':(/audio/.test(mode)?'Audio':'Video'),bitrate?Math.round(bitrate/1000)+' kbps':null,rep.getAttribute('codecs')].filter(Boolean).join(' · ')});
    continue;
   }
   const urls=dashChildren(list,'SegmentURL');
   if(!urls.length||urls.length>5000||urls.some(e=>e.hasAttribute('mediaRange')||e.hasAttribute('indexRange')))continue;
   const init=dashFirst(list,'Initialization');
   if(init&&(init.hasAttribute('range')||!init.getAttribute('sourceURL')))continue;
   const rbase=appendBase(rep,base), segments=urls.map(e=>abs(e.getAttribute('media'),rbase));
   if(urls.some(e=>!e.getAttribute('media')))continue;
   const height=Number(rep.getAttribute('height')||0),bitrate=Number(rep.getAttribute('bandwidth')||0);
   tracks.push({url:manifestUrl,kind:/audio/.test(mode)?'audio':'video',height,bitrate,mime,segments,init:init?abs(init.getAttribute('sourceURL'),rbase):null,label:[height?height+'p':(/audio/.test(mode)?'Audio':'Video'),bitrate?Math.round(bitrate/1000)+' kbps':null,rep.getAttribute('codecs')].filter(Boolean).join(' · ')});
  }
 }
 if(!tracks.length)throw Error('Unsupported DASH layout: requires explicit SegmentList or static duration-based SegmentTemplate.');
 return tracks;
}
async function getDashTrack(track,downloadName){
 const urls=track.init?[track.init,...track.segments]:track.segments;
 const buffers=[];let size=0;
 for(let i=0;i<urls.length;i++){
  if(state.cancel)throw Error('Cancelled');
  const r=await fetch(urls[i],{credentials:'include'});if(!r.ok)throw Error('DASH segment HTTP '+r.status);
  const bytes=await r.arrayBuffer();size+=bytes.byteLength;
  if(size>1024*1024*1024)throw Error('DASH data exceeds the 1 GiB memory safety cap');
  buffers.push(bytes);$('progress').value=Math.round((i+1)*100/urls.length);
  $('status').textContent=track.kind+' segment '+(i+1)+'/'+urls.length;
 }
 const ext=/webm/.test(track.mime)?'webm':track.kind==='audio'?'m4a':'mp4';
 const blob=new Blob(buffers,{type:track.mime||'application/octet-stream'});
 const local=URL.createObjectURL(blob),a=document.createElement('a');a.href=local;
 a.download=downloadName+'.'+ext;document.body.append(a);a.click();a.remove();
 setTimeout(()=>URL.revokeObjectURL(local),120000);return a.download;
}

async function load(){try{if(!source)throw Error('No stream URL supplied');remote(source);if(/\.mpd(?:$|[?#])/i.test(source)){dashState.tracks=parseDash(await fetchText(source),source);state.variants=dashState.tracks.filter(t=>t.kind==='video');state.audioRenditions=dashState.tracks.filter(t=>t.kind==='audio');if(!state.variants.length)state.variants=dashState.tracks.filter(t=>t.kind==='audio');}if(!dashState.tracks.length)state.variants=await openPlaylist(source);for(const [i,v]of state.variants.entries()){const o=document.createElement('option');o.value=i;o.textContent=v.label;$('qualities').append(o)}const preference=(await chrome.storage.local.get({preferredQuality:'highest',preferOriginalAudio:true})).preferredQuality;const options=state.variants;let chosen=0;if(preference!=='highest'){const target=Number(preference);chosen=options.findIndex(o=>o.height>0&&o.height<=target);if(chosen<0)chosen=options.length-1;}$('qualities').value=String(chosen);const audio=$('audio');for(const [i,a] of state.audioRenditions.entries()){const opt=document.createElement('option');opt.value=String(i);opt.textContent=(a.language?a.language+' · ':'')+(a.name||a.label||'Audio');audio.append(opt)}
if(state.audioRenditions.length && (await chrome.storage.local.get({preferOriginalAudio:true})).preferOriginalAudio){const preferred=state.audioRenditions.findIndex(a=>(!state.variants[chosen]?.audioGroup||a.group===state.variants[chosen].audioGroup)&&(a.language==='en'||a.name?.toLowerCase().includes('english')));const pick=preferred>=0?preferred:state.audioRenditions.findIndex(a=>!state.variants[chosen]?.audioGroup||a.group===state.variants[chosen].audioGroup);if(pick>=0)$('audio').value=String(pick);}
$('start').disabled=false;$('status').textContent=`${state.variants.length} source quality option(s) found. Audio can be separate; choose a track when available. No DRM or conversion.`;}catch(e){$('status').textContent=e.message}}
$('cancel').onclick=()=>{state.cancel=true;$('status').textContent='Stopping after current segment…';};
$('start').onclick=async()=>{
 if(state.busy)return;state.busy=true;state.cancel=false;$('start').disabled=true;$('cancel').disabled=false;
 try{
  const v=state.variants[Number($('qualities').value)];const chosenAudio=$('audio').value;
  if(dashState.tracks.length){const base=displayTitle+'-DASH-'+Date.now();const videoName=await getDashTrack(v,base+'-video');let audioName=null;if(chosenAudio!==''){const a=state.audioRenditions[Number(chosenAudio)];if(!a)throw Error('Invalid audio track');audioName=await getDashTrack(a,base+'-audio')} $('status').textContent=audioName?'Saved '+videoName+' and '+audioName+' separately. Use a media muxer to combine them; no re-encoding was done.':'Saved '+videoName+'. Audio may be separate.';return;}

  if(v.audioGroup && chosenAudio==='')throw Error('This variant declares separate audio. Choose an audio rendition to download it separately; video-only playback may be silent.');
  if(chosenAudio!=='' && (!state.audioRenditions[Number(chosenAudio)] || (v.audioGroup && state.audioRenditions[Number(chosenAudio)].group!==v.audioGroup)))throw Error('Selected audio rendition is not compatible with this video variant.');
  const manifest=await fetchText(v.url);if(manifest.includes('#EXT-X-STREAM-INF'))throw Error('Nested master playlist not supported.');
  const media=parseMedia(manifest,v.url);const all=media.init?[media.init,...media.segments]:media.segments;
  const chunks=[];let total=0;
  for(let i=0;i<all.length;i++){
    if(state.cancel)throw Error('Cancelled');
    let buffer=null;
    for(let attempt=0;attempt<3;attempt++){
      try{const r=await fetch(all[i],{credentials:'include'});if(!r.ok)throw Error('HTTP '+r.status);buffer=await r.arrayBuffer();break}catch(e){if(attempt===2)throw Error(`Segment ${i+1} failed: ${e.message}`)}
    }
    total+=buffer.byteLength;
    if(total>1024*1024*1024)throw Error('In-browser download safety cap is 1 GiB. No file saved.');
    chunks.push(buffer);$('progress').value=Math.round((i+1)*100/all.length);$('status').textContent=`Segment ${i+1}/${all.length} · ${(total/1048576).toFixed(1)} MiB`;
  }
  if(state.cancel)throw Error('Cancelled');
  const file=new Blob(chunks,{type:media.type==='mp4'?'video/mp4':'video/mp2t'});
  const link=document.createElement('a');const local=URL.createObjectURL(file);
  link.href=local;link.download=`${displayTitle}-${Date.now()}.${media.type}`;document.body.appendChild(link);link.click();link.remove();
  $('status').textContent=`Prepared ${link.download} (${(total/1048576).toFixed(1)} MiB). Check your browser downloads.`;
  setTimeout(()=>URL.revokeObjectURL(local),120000);
  if(chosenAudio!==''){
    const a=state.audioRenditions[Number(chosenAudio)];
    if(a && (!v.audioGroup || a.group===v.audioGroup)){
      $('status').textContent='Video saved. Downloading separate original audio (not muxed)…';
      const audioText=await fetchText(a.url);const audioMedia=parseMedia(audioText,a.url);const audioUrls=audioMedia.init?[audioMedia.init,...audioMedia.segments]:audioMedia.segments;
      const audioChunks=[];let audioTotal=0;
      for(let i=0;i<audioUrls.length;i++){
        if(state.cancel)throw Error('Audio download cancelled');
        const r=await fetch(audioUrls[i],{credentials:'include'});if(!r.ok)throw Error('Audio segment HTTP '+r.status);
        const bytes=await r.arrayBuffer();audioTotal+=bytes.byteLength;
        if(audioTotal>1024*1024*1024)throw Error('Audio exceeded safety cap');audioChunks.push(bytes);
        $('status').textContent='Audio '+(i+1)+'/'+audioUrls.length+' segments';
      }
      const audioLocal=URL.createObjectURL(new Blob(audioChunks,{type:audioMedia.type==='mp4'?'audio/mp4':'video/mp2t'}));
      const audioLink=document.createElement('a');audioLink.href=audioLocal;audioLink.download=displayTitle+'-audio-'+Date.now()+'.'+(audioMedia.type==='mp4'?'m4a':'ts');
      document.body.append(audioLink);audioLink.click();audioLink.remove();setTimeout(()=>URL.revokeObjectURL(audioLocal),120000);
      $('status').textContent='Video and audio saved as TWO separate original files. Muxing not available.';
    }else throw Error('Audio selection does not match the chosen video quality group.');
  }
 }catch(e){$('status').textContent=e.message}finally{state.busy=false;$('start').disabled=false;$('cancel').disabled=true}
};
load();
