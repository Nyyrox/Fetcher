const ANIKOTO_URL = "https://anikototv.to";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...CORS, "content-type": "application/json; charset=utf-8" },
  });
}

function normalize(v: unknown) {
  return String(v ?? "")
    .toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ").replace(/re:zero/g, "re zero")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\b(the|a|an)\b/g, " ").replace(/\s+/g, " ").trim();
}
function tokens(v: unknown) { return new Set(normalize(v).split(" ").filter(x => x.length > 1)); }
function tokenScore(a: string, b: string) {
  const A=tokens(a), B=tokens(b); if(!A.size||!B.size)return 0;
  let common=0; for(const x of A)if(B.has(x))common++;
  return (2*common)/(A.size+B.size);
}
function abs(value: string, base=ANIKOTO_URL){try{return new URL(value,base).toString()}catch{return null}}
function slugFromUrl(url:string){try{return new URL(url).pathname.match(/^\/watch\/([^/]+)/i)?.[1]||null}catch{return null}}
function decodeText(s:string){return s.replace(/<[^>]*>/g," ").replace(/&amp;/g,"&").replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/&nbsp;/g," ").replace(/&#x27;/gi,"'").replace(/&#58;/gi,":").replace(/\s+/g," ").trim()}
function unique<T>(a:T[]){return [...new Set(a)]}

function metadataTitles(m:any){
  const t=m?.title||{}; const syn=Array.isArray(m?.synonyms)?m.synonyms:String(m?.synonyms||"").split(",");
  return unique([t.english,t.romaji,t.native,t.userPreferred,m?.english,m?.romaji,m?.native,m?.userPreferred,m?.title,m?.name,...syn].filter(Boolean).map(String));
}
function makeMetadata(input:any){
  const syn=Array.isArray(input.synonyms)?input.synonyms:String(input.synonyms||"").split(",").map((x:string)=>x.trim()).filter(Boolean);
  return {id:Number(input.anilist||input.id)||null,idMal:Number(input.idMal||input.mal)||null,format:input.format?String(input.format).toUpperCase():null,episodes:Number(input.episodes)||null,seasonYear:Number(input.seasonYear||input.year)||null,title:{english:input.english||input.title||input.name||null,romaji:input.romaji||input.title||input.name||null,native:input.native||null,userPreferred:input.userPreferred||input.title||input.name||null},synonyms:unique([input.title,input.name,input.english,input.romaji,input.native,input.userPreferred,...syn].filter(Boolean).map(String))};
}

// Anikoto appends a random 5-character identifier to each show slug.
function baseSlug(slug:string){return String(slug||"").replace(/-([a-z0-9]{5})$/i,"").replace(/-+/g,"-").replace(/^-|-$/g,"")}
function slugTitle(slug:string){return decodeURIComponent(baseSlug(slug)).replace(/[-_]+/g," ").trim()}
function seasonNumber(slug:string){const s=baseSlug(slug).toLowerCase();const m=s.match(/(?:^|[- ])season[- ]?(\d+)(?:$|[- ])/);return m?Number(m[1]):0}

function parseAnikoto(html:string){
  const out:any[]=[]; const re=/<a\b([^>]*\bhref=["'][^"']*\/watch\/[^"']+["'][^>]*)>([\s\S]*?)<\/a>/gi; let m:RegExpExecArray|null;
  while((m=re.exec(html))){
    const attrs=m[1],inner=m[2]; const href=attrs.match(/\bhref=["']([^"']+)["']/i)?.[1]; const url=href?abs(href.replace(/\\\//g,"/")):null; if(!url)continue;
    const slug=slugFromUrl(url); if(!slug||out.some(x=>x.slug===slug))continue;
    const dataJp=attrs.match(/\bdata-jp=["']([^"']*)["']/i)?.[1]||"";
    const dataTitle=attrs.match(/\b(?:data-title|title)=["']([^"']*)["']/i)?.[1]||"";
    const visible=decodeText(inner);
    const year=attrs.match(/\bdata-year=["'](\d{4})["']/i)?.[1]||visible.match(/\b((?:19|20)\d{2})\b/)?.[1]||null;
    const type=decodeText(attrs.match(/\bdata-type=["']([^"']+)/i)?.[1]||visible.match(/\b(movie|tv|ova|ona|special|music)\b/i)?.[1]||"");
    const attrTitle=decodeText(dataTitle||dataJp);
    const usableVisible=visible.replace(/\b(movie|tv|ova|ona|special|music)\b/gi," ").replace(/\b\d+\b/g," ").replace(/\s+/g," ").trim();
    const title=attrTitle||(usableVisible.length>=3?usableVisible:slugTitle(slug));
    out.push({url,slug,title,slugTitle:slugTitle(slug),jp:dataJp,year,type,season:seasonNumber(slug)});
  }
  return out;
}

async function anikotoSearch(keyword:string){
  const page=new URL("/filter",ANIKOTO_URL); page.searchParams.set("keyword",keyword);
  const r=await fetch(page,{headers:{"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",Accept:"text/html,application/xhtml+xml,application/json,*/*",Referer:`${ANIKOTO_URL}/`},redirect:"follow"});
  if(!r.ok)throw new Error(`Anikoto search HTTP ${r.status}`); return parseAnikoto(await r.text());
}

function scoreCandidate(c:any,metadata:any){
  const variants=metadataTitles(metadata); let best=0,matchedTitle="",matchSource="";
  for(const v of variants){const nv=normalize(v);if(!nv)continue;const titleScore=tokenScore(c.title,v)*100,slugScore=tokenScore(c.slugTitle,v)*100;const exactTitle=normalize(c.title)===nv,exactSlug=normalize(c.slugTitle)===nv;let s=Math.max(titleScore,slugScore*1.12);if(exactTitle)s=Math.max(s,108);if(exactSlug)s=Math.max(s,115);if(s>best){best=s;matchedTitle=v;matchSource=exactSlug?"slug-exact":exactTitle?"title-exact":slugScore>=titleScore?"slug":"title"}}
  if(metadata.seasonYear&&c.year)best+=Number(metadata.seasonYear)===Number(c.year)?18:-18;
  const fmt=String(metadata.format||"").toLowerCase(),type=String(c.type||"").toLowerCase();
  if(fmt==="movie")best+=type==="movie"?10:-12; else if(fmt&&type&&type!==fmt)best-=5;
  const exactCanonical=variants.map(normalize).includes(normalize(c.slugTitle));
  if(exactCanonical&&c.season===0)best+=20; if(c.season>0&&exactCanonical)best-=8;
  return {score:Math.round(Math.max(0,Math.min(140,best))),matchedTitle,matchSource};
}

async function resolveFromMetadata(metadata:any){
  const variants=metadataTitles(metadata); if(!variants.length)return json({ok:false,error:"Missing anime title metadata"},400);
  const terms=unique(variants).sort((a,b)=>b.length-a.length).slice(0,8); const all=new Map<string,any>();
  for(const term of terms){try{for(const c of await anikotoSearch(term))all.set(c.slug,c)}catch{}}
  const ranked=[...all.values()].map(c=>({...c,...scoreCandidate(c,metadata)})).sort((a,b)=>b.score-a.score);
  const best=ranked[0]||null,second=ranked[1]||null; const confident=!!best&&best.score>=90; const ambiguous=!!best&&!!second&&best.score>=100&&second.score>=100&&(best.score-second.score<5);
  const match=confident&&!ambiguous?{title:best.slugTitle||best.title,slug:best.slug,url:best.url,episodeUrl:`${best.url.replace(/\/+$/,"")}/ep-1`,score:best.score,matchedTitle:best.matchedTitle,matchSource:best.matchSource,season:best.season||0}:null;
  return json({ok:!!match,metadata,match,alternatives:ranked.slice(0,10),searched:terms,reason:!best?"No Anikoto candidate found":ambiguous?"Ambiguous match":match?"Exact/high-confidence match":"No high-confidence match"});
}

async function readMetadata(request:Request,url:URL){
  const input:any={}; for(const key of ["title","name","english","romaji","native","userPreferred","synonyms","year","seasonYear","format","episodes","idMal","mal","id","anilist"]){const v=url.searchParams.get(key);if(v!==null)input[key]=v}
  if(request.method==="POST"){const ct=request.headers.get("content-type")||"";try{if(ct.includes("application/json"))Object.assign(input,await request.clone().json());else if(ct.includes("form")){const f=await request.clone().formData();for(const [k,v]of f)input[k]=String(v)}}catch{}}
  return input;
}

function validateTarget(raw:string){let u:URL;try{u=new URL(raw)}catch{throw Object.assign(new Error("Invalid target URL"),{status:400})}if(!["http:","https:"].includes(u.protocol))throw Object.assign(new Error("Only HTTP(S) URLs are supported"),{status:400});const h=u.hostname.toLowerCase();if(h==="localhost"||h==="127.0.0.1"||h==="::1"||h.endsWith(".local"))throw Object.assign(new Error("Local targets are blocked"),{status:403});return u}
function upstreamHeaders(request:Request){const h=new Headers();for(const n of ["Accept","Accept-Language","Content-Type","Range","If-None-Match","If-Modified-Since","User-Agent"]){const v=request.headers.get(n);if(v)h.set(n,v)}return h}
function endpoints(text:string,base:string){const out:string[]=[];const patterns=[/["'`]((?:https?:)?\/\/[^"'`\s<>]+)["'`]/gi,/["'`]((?:\/|\.\/|\.\.\/)(?:api|ajax|graphql|search|filter|watch|episode|episodes|stream|source|player|download|proxy)[^"'`\s<>]*)["'`]/gi,/["'`]([^"'`\s<>]+\.(?:m3u8|mpd|mp4|m4v|webm)(?:\?[^"'`\s<>]*)?)["'`]/gi];for(const re of patterns){let m:RegExpExecArray|null;while((m=re.exec(text))){const u=abs(m[1],base);if(u)out.push(u)}}return unique(out)}

async function inspectPage(target:URL,request:Request){const h=upstreamHeaders(request);h.set("User-Agent",h.get("User-Agent")||"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36");const r=await fetch(target,{headers:h,redirect:"follow"});const ct=r.headers.get("content-type")||"";const body=await r.text();if(!ct.includes("text/html")&&!/<(?:html|script|body)\b/i.test(body))return json({ok:true,status:r.status,finalUrl:r.url,contentType:ct,bodyPreview:body.slice(0,2000)});const scripts=unique([...body.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map(x=>abs(x[1],r.url)).filter(Boolean)as string[]);const iframes=unique([...body.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)].map(x=>abs(x[1],r.url)).filter(Boolean)as string[]);const hrefs=unique([...body.matchAll(/(?:href|action)=["']([^"']+)["']/gi)].map(x=>abs(x[1],r.url)).filter(Boolean)as string[]);const found=endpoints(body,r.url);const assetFindings:any[]=[];for(const s of scripts.filter(x=>/\.m?js(?:[?#]|$)/i.test(x)).slice(0,12)){try{const ar=await fetch(s,{headers:{"User-Agent":h.get("User-Agent")!}});const text=await ar.text();const e=endpoints(text,s);if(e.length)assetFindings.push({script:s,endpoints:e.slice(0,100)})}catch{}}return json({ok:true,status:r.status,finalUrl:r.url,contentType:ct,page:{title:decodeText(body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]||""),size:body.length},scripts,iframes,ajaxCalls:[],apiEndpoints:found.filter(x=>/(?:\/api\/|\/ajax\/|graphql|\.json(?:\?|$))/i.test(x)),mediaEndpoints:found.filter(x=>/\.(?:m3u8|mpd|mp4|m4v|webm)(?:\?|$)/i.test(x)),dataUrls:[],hrefs,javascriptAssetFindings:assetFindings,note:"Static inspection only; browser-executed JavaScript requests are not observed by a Worker."})}

async function proxy(target:URL,request:Request){const u=validateTarget(target.searchParams.get("url")||"");const r=await fetch(u,{method:request.method,headers:upstreamHeaders(request),redirect:"follow",body:["GET","HEAD"].includes(request.method)?undefined:request.body});const h=new Headers(CORS);for(const n of ["Content-Type","Content-Length","Content-Range","Accept-Ranges","ETag","Last-Modified","Cache-Control","Expires","Location","Content-Encoding"]){const v=r.headers.get(n);if(v)h.set(n,v)}return new Response(r.body,{status:r.status,headers:h})}
async function fetchPage(target:URL,request:Request){const u=validateTarget(target.searchParams.get("url")||"");const h=upstreamHeaders(request);h.set("User-Agent",h.get("User-Agent")||"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36");const r=await fetch(u,{headers:h,redirect:"follow"});return json({ok:r.ok,status:r.status,finalUrl:r.url,contentType:r.headers.get("content-type")||"",body:await r.text()},r.ok?200:r.status)}

export default {async fetch(request:Request):Promise<Response>{if(request.method==="OPTIONS")return new Response(null,{status:204,headers:CORS});const url=new URL(request.url),path=url.pathname.replace(/\/+$/,"")||"/";try{
  if(path==="/"||path==="/help")return json({ok:true,service:"Fetcher + Anikoto resolver",endpoints:{resolve:"/resolve?title=Re:ZERO%20-Starting%20Life%20in%20Another%20World-&year=2016&format=TV&episodes=25",search:"/search?keyword=Naruto",inspect:"/inspect?url=<url>",fetch:"/fetch?url=<url>",proxy:"/proxy?url=<url>"},note:"POST AniList metadata to /resolve from your APK/HTML. Resolver does not depend on AniList GraphQL."});
  if(path==="/resolve"){const metadata=makeMetadata(await readMetadata(request,url));return resolveFromMetadata(metadata)}
  if(path==="/search"){const keyword=url.searchParams.get("keyword")||url.searchParams.get("q")||"";if(!keyword.trim())return json({ok:false,error:"Missing ?keyword="},400);return json({ok:true,keyword,results:await anikotoSearch(keyword.trim())})}
  if(path==="/inspect"){const raw=url.searchParams.get("url");if(!raw)return json({ok:false,error:"Missing ?url="},400);return inspectPage(validateTarget(raw),request)}
  if(path==="/fetch"){const raw=url.searchParams.get("url");if(!raw)return json({ok:false,error:"Missing ?url="},400);return fetchPage(url,request)}
  if(path==="/proxy"){const raw=url.searchParams.get("url");if(!raw)return json({ok:false,error:"Missing ?url="},400);return proxy(url,request)}
  return json({ok:false,error:"Not found"},404);
}catch(e:any){return json({ok:false,error:String(e?.message||e)},Number(e?.status)||500)}}};
