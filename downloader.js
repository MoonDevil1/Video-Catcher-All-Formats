'use strict';
const $=id=>document.getElementById(id);
const source=new URL(location.href).searchParams.get('url');
let options=[],running=false,controller=null;
const status=s=>{$('status').textContent=s};
function uri(input,base){const u=new URL(input.trim().replace(/^"|"$/g,''),base);if(!['http:','https:'].includes(u.protocol))throw Error('Invalid media URL');return u.href}
function attrs(line){let out={};for(const match of line.matchAll(/([\w-]+)=("[^"]*"|[^,]*)/g))out[match[1]]=match[2].replace(/^"|"$/g,'');return out}
async function getText(url,signal){const r=await fetch(url,{credentials:'include',signal});if(!r.ok)throw Error('HTTP '+r.status+' fetching playlist');return (await r.text()).replace(/^\uFEFF/,'')}
async function inspect(url){const raw=await getText(url);if(!raw.trimStart().startsWith('#EXTM3U'))throw Error('Not a supported HLS playlist');const lines=raw.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);return lines}
async function load(){try{if(!source)throw Error('No playlist provided');if(/\.mpd(?:[?#]|$)/i.test(source))throw Error('DASH is detected but downloading is not supported');const base=uri(source,source),lines=await inspect(base);let a=[];for(let i=0;i<lines.length;i++){if(!lines[i].startsWith('#EXT-X-STREAM-INF:'))continue;const at=attrs(lines[i]);let j=i+1;while(j<lines.length&&lines[j].startsWith('#'))j++;if(!lines[j])continue;const height=at.RESOLUTION?.split('x')[1];a.push({url:uri(lines[j],base),label:[height?height+'p':'Auto',at.BANDWIDTH?Math.round(Number(at.BANDWIDTH)/1000)+' kbps':null,at.CODECS].filter(Boolean).join(' · '),audioGroup:at.AUDIO||null})}options=a.length?a:[{url:base,label:'Original source',audioGroup:null}];for(let i=0;i<options.length;i++){const opt=document.createElement('option');opt.value=String(i);opt.textContent=options[i].label;$('qualities').append(opt)}$('start').disabled=false;status(options.length+' quality option(s) detected.')}catch(e){status(e.message)}}
$('cancel').onclick=()=>{controller?.abort()};
$('start').onclick=async()=>{if(running)return;running=true;controller=new AbortController();$('start').disabled=true;$('cancel').disabled=false;$('progress').value=0;
try{const v=options[Number($('qualities').value)];if(v.audioGroup)throw Error('This rendition declares a separate audio group. Audio merging is not supported, so no silent video will be saved.');const lines=await inspect(v.url);
if(lines.some(l=>l.startsWith('#EXT-X-STREAM-INF')))throw Error('Nested master playlist unsupported');
if(!lines.includes('#EXT-X-ENDLIST'))throw Error('Only completed video-on-demand playlists supported');
if(lines.some(l=>l.startsWith('#EXT-X-KEY:')&&!/METHOD=NONE(?:,|$)/.test(l)))throw Error('Encrypted streams are not supported');
if(lines.some(l=>/^#EXT-X-(BYTERANGE|I-FRAMES-ONLY|PART|PRELOAD-HINT|DISCONTINUITY|MAP:.*BYTERANGE)/.test(l)))throw Error('Playlist uses unsupported segment features');
const initLine=lines.find(l=>l.startsWith('#EXT-X-MAP:'));
const init=initLine?attrs(initLine).URI:null;
if(initLine&&!init)throw Error('Invalid initialization segment');
const segments=lines.filter(l=>!l.startsWith('#')).map(l=>uri(l,v.url));
if(segments.length===0||segments.length>4000)throw Error('Unsupported segment count');
const target=init?[uri(init,v.url),...segments]:segments;
let total=0;const buffers=[];
for(let i=0;i<target.length;i++){const r=await fetch(target[i],{credentials:'include',signal:controller.signal});if(!r.ok)throw Error('Segment '+(i+1)+' HTTP '+r.status);const buf=await r.arrayBuffer();total+=buf.byteLength;if(total>768*1024*1024)throw Error('File exceeds 768 MiB in-memory limit');buffers.push(buf);$('progress').value=Math.floor((i+1)*100/target.length);status('Downloading '+(i+1)+' / '+target.length+' segments · '+(total/1048576).toFixed(1)+' MiB')}
const ext=init?'mp4':'ts';const blob=new Blob(buffers,{type:init?'video/mp4':'video/mp2t'});const local=URL.createObjectURL(blob);const anchor=document.createElement('a');anchor.href=local;anchor.download='VideoCatcher-'+Date.now()+'.'+ext;document.body.append(anchor);anchor.click();anchor.remove();status('Prepared '+anchor.download+' ('+(total/1048576).toFixed(1)+' MiB). Original streams have not been re-encoded.');setTimeout(()=>URL.revokeObjectURL(local),120000);
}catch(e){status(e.name==='AbortError'?'Download cancelled':e.message)}finally{controller=null;running=false;$('start').disabled=false;$('cancel').disabled=true}};
load();
