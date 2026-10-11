'use strict';
/** SG Listening 2.0.0. App assets are cached; user audio lives only in IndexedDB.
 * No imports, third-party requests, background upload, or analytics.
 */
const VERSION='2.0.0';
const BASE=new URL('./',self.location.href);
const SCOPE_TAG=Array.from(BASE.pathname).reduce((h,c)=>((h*31+c.charCodeAt(0))>>>0),0).toString(16);
const CACHE_PREFIX='sg-listening-shell-'+SCOPE_TAG+'-';
const CACHE_NAME=CACHE_PREFIX+VERSION;
const DB_NAME='sg-listening-local-v1';
const ASSETS=['./','./index.html','./app.css','./app.js','./manifest.webmanifest','./icons/icon-192.png','./icons/icon-512.png','./icons/maskable-512.png','./icons/apple-touch-icon.png'];
const ASSET_URLS=ASSETS.map(p=>new URL(p,BASE).href);
const AUDIO_PREFIX=new URL('./__local_audio__/',BASE).pathname;
let databasePromise;
function openDatabase(){
 if(databasePromise)return databasePromise;
 databasePromise=new Promise((resolve,reject)=>{
  const req=indexedDB.open(DB_NAME,1);
  req.onupgradeneeded=()=>{const d=req.result;for(const name of ['tracks','audio','settings'])if(!d.objectStoreNames.contains(name))d.createObjectStore(name,{keyPath:name==='settings'?'key':'id'});};
  req.onsuccess=()=>{req.result.onversionchange=()=>{req.result.close();databasePromise=null;};resolve(req.result);};
  req.onerror=()=>{databasePromise=null;reject(req.error);};
  req.onblocked=()=>{databasePromise=null;reject(new Error('Database blocked'));};
 });
 return databasePromise;
}
async function audioRecord(id){const db=await openDatabase();return new Promise((resolve,reject)=>{const tx=db.transaction('audio','readonly');const req=tx.objectStore('audio').get(id);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
async function audioCount(){const db=await openDatabase();return new Promise((resolve,reject)=>{const req=db.transaction('audio','readonly').objectStore('audio').count();req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
self.addEventListener('install',event=>{
 // No skipWaiting here: an updated app must never interrupt a listening session.
 event.waitUntil((async()=>{const cache=await caches.open(CACHE_NAME);await cache.addAll(ASSET_URLS.map(url=>new Request(url,{cache:'reload',credentials:'same-origin'})));})());
});
self.addEventListener('activate',event=>{event.waitUntil((async()=>{
 for(const key of await caches.keys())if(key.startsWith(CACHE_PREFIX)&&key!==CACHE_NAME)await caches.delete(key);
 await self.clients.claim();
})());});
function rangeBounds(header,size){
 if(!header)return null;
 const match=/^bytes=(\d*)-(\d*)$/.exec(header.trim());
 if(!match||(!match[1]&&!match[2]))return false;
 let start,end;
 if(!match[1]){const suffix=Number(match[2]);if(!Number.isSafeInteger(suffix)||suffix<=0)return false;start=Math.max(0,size-suffix);end=size-1;}
 else{start=Number(match[1]);end=match[2]?Number(match[2]):size-1;if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end))return false;end=Math.min(end,size-1);}
 if(start<0||start>=size||end<start)return false;
 return {start,end};
}
async function serveAudio(request,url){
 try{
  const id=url.pathname.slice(AUDIO_PREFIX.length);
  if(!/^d(0[1-9]|1[0-4])t0[1-4]$/.test(id))return new Response('Unknown audio slot',{status:404});
  const record=await audioRecord(id);
  if(!(record?.blob instanceof Blob)||record.blob.size===0)return new Response('Audio not saved on this device',{status:404});
  const blob=record.blob;
  const headers=new Headers({'Content-Type':blob.type||'application/octet-stream','Accept-Ranges':'bytes','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  // HEAD describes the whole representation, regardless of the Range request header.
  if(request.method==='HEAD'){headers.set('Content-Length',String(blob.size));return new Response(null,{status:200,headers});}
  const range=rangeBounds(request.headers.get('range'),blob.size);
  if(range===false){headers.set('Content-Range','bytes */'+blob.size);return new Response(null,{status:416,headers});}
  if(range){headers.set('Content-Range',`bytes ${range.start}-${range.end}/${blob.size}`);headers.set('Content-Length',String(range.end-range.start+1));return new Response(blob.slice(range.start,range.end+1,blob.type),{status:206,headers});}
  headers.set('Content-Length',String(blob.size));return new Response(blob,{status:200,headers});
 }catch(error){console.error('Local audio read failed',error);return new Response('Local audio storage unavailable',{status:503});}
}
self.addEventListener('fetch',event=>{
 const request=event.request,url=new URL(request.url);
 if(url.origin!==BASE.origin)return;
 // This virtual endpoint is never passed through to the public hosting server.
 if(url.pathname.startsWith(AUDIO_PREFIX)){
  event.respondWith(request.method==='GET'||request.method==='HEAD'?serveAudio(request,url):Promise.resolve(new Response('Method not allowed',{status:405,headers:{Allow:'GET, HEAD'}})));return;
 }
 if(request.method!=='GET'||!url.pathname.startsWith(BASE.pathname))return;
 if(request.mode==='navigate'){
  event.respondWith((async()=>{const cached=await caches.match(new URL('./index.html',BASE).href,{cacheName:CACHE_NAME});return cached||fetch(request);})());return;
 }
 const key=url.origin+url.pathname;
 if(ASSET_URLS.includes(key))event.respondWith((async()=>{const cache=await caches.open(CACHE_NAME);const cached=await cache.match(key);if(cached)return cached;return fetch(request);})());
});
self.addEventListener('message',event=>{
 if(event.data?.type==='SKIP_WAITING'){event.waitUntil(self.skipWaiting());return;}
 if(event.data?.type==='STATUS')event.waitUntil((async()=>{
  try{const cache=await caches.open(CACHE_NAME);const hits=await Promise.all(ASSET_URLS.map(url=>cache.match(url)));const count=await audioCount().catch(()=>null);event.ports[0]?.postMessage({version:VERSION,shellReady:hits.every(Boolean),audioCount:count});}
  catch{event.ports[0]?.postMessage({version:VERSION,shellReady:false,audioCount:null});}
 })());
});
