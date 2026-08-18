const ANILIST_URL = "https://graphql.anilist.co";
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
    .replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\b(the|a|an)\b/g, " ").replace(/\s+/g, " ").trim();
}

function tokenScore(a: string, b: string) {
  const A = new Set(normalize(a).split(" ").filter(x => x.length > 1));
  const B = new Set(normalize(b).split(" ").filter(x => x.length > 1));
  if (!A.size || !B.size) return 0;
  let common = 0;
  for (const x of A) if (B.has(x)) common++;
  return (2 * common) / (A.size + B.size);
}

function slugFromUrl(url: string) {
  try { return new URL(url).pathname.match(/^\/watch\/([^/]+)/i)?.[1] || null; }
  catch { return null; }
}

function abs(value: string, base = ANIKOTO_URL) {
  try { return new URL(value, base).toString(); } catch { return null; }
}

function decodeText(s: string) {
  return s.replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ").replace(/&#x27;/gi, "'")
    .replace(/\s+/g, " ").trim();
}

function titleVariants(m: any) {
  const t = m?.title || {};
  const syn = Array.isArray(m?.synonyms) ? m.synonyms : [];
  return [...new Set([t.english, t.romaji, t.native, t.userPreferred, ...syn]
    .filter(Boolean).map(String))];
}

function makeMetadata(input: any) {
  const titles = [input.title, input.name, input.english, input.romaji, input.native,
    ...(Array.isArray(input.synonyms) ? input.synonyms : String(input.synonyms || "").split(","))]
    .filter(Boolean).map(String);
  const uniq = [...new Set(titles)];
  return {
    id: input.anilist ? Number(input.anilist) || null : input.id ? Number(input.id) || null : null,
    idMal: input.idMal ? Number(input.idMal) || null : input.mal ? Number(input.mal) || null : null,
    format: input.format ? String(input.format).toUpperCase() : null,
    episodes: input.episodes ? Number(input.episodes) || null : null,
    seasonYear: input.seasonYear ? Number(input.seasonYear) || null : input.year ? Number(input.year) || null : null,
    title: {
      english: input.english || input.title || input.name || null,
      romaji: input.romaji || input.title || input.name || null,
      native: input.native || null,
      userPreferred: input.userPreferred || input.title || input.name || null,
    },
    synonyms: uniq,
  };
}

async function getAniListMetadata(id: number) {
  const query = `query ($id:Int!){ Media(id:$id,type:ANIME){ id idMal format episodes seasonYear title{romaji english native userPreferred} synonyms } }`;
  const r = await fetch(ANILIST_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ query, variables: { id } }),
  });
  if (!r.ok) throw new Error(`AniList HTTP ${r.status}`);
  const b: any = await r.json();
  if (b.errors?.length) throw new Error(b.errors[0].message || "AniList error");
  return b.data?.Media || null;
}

function parseAnikoto(html: string) {
  const out: any[] = [];
  const re = /<a\b([^>]*\bhref=["'][^"']*\/watch\/[^"']+["'][^>]*)>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const attrs = m[1], inner = m[2];
    const href = attrs.match(/\bhref=["']([^"']+)["']/i)?.[1];
    const url = href ? abs(href.replace(/\\\//g, "/")) : null;
    if (!url) continue;
    const slug = slugFromUrl(url);
    if (!slug || out.some(x => x.slug === slug)) continue;
    const dataJp = attrs.match(/\bdata-jp=["']([^"']*)["']/i)?.[1] || "";
    const dataTitle = attrs.match(/\b(?:data-title|title)=["']([^"']*)["']/i)?.[1] || "";
    let title = decodeText(dataTitle || dataJp || inner);
    title = title.replace(/\b(?:Watch|Episode)\b.*$/i, "").trim();
    if (!title) title = slug.replace(/-/g, " ");
    const year = inner.match(/\b(19|20)\d{2}\b/)?.[0] || attrs.match(/\bdata-year=["'](\d{4})["']/i)?.[1] || null;
    const type = decodeText(inner.match(/\b(movie|tv|ova|ona|special|music)\b/i)?.[1] || attrs.match(/\bdata-type=["']([^"']+)/i)?.[1] || "");
    out.push({ url, slug, title, jp: dataJp, year, type });
  }
  return out;
}

async function anikotoSearch(keyword: string) {
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/json,*/*",
    Referer: `${ANIKOTO_URL}/`,
  };

  // The normal site filter is more reliable than guessing a private AJAX API.
  const page = new URL("/filter", ANIKOTO_URL);
  page.searchParams.set("keyword", keyword);
  const r = await fetch(page, { headers, redirect: "follow" });
  if (!r.ok) throw new Error(`Anikoto search HTTP ${r.status}`);
  const html = await r.text();
  return parseAnikoto(html);
}

function scoreCandidate(c: any, metadata: any) {
  const variants = titleVariants(metadata);
  let score = 0, matchedTitle = "";
  for (const v of variants) {
    const a = normalize(c.title), b = normalize(v);
    if (!a || !b) continue;
    let s = a === b ? 100 : Math.round(tokenScore(c.title, v) * 80);
    // Strongly reward slug/title equivalence as well.
    const slugText = normalize(c.slug.replace(/-/g, " "));
    if (slugText === b) s = Math.max(s, 96);
    if (s > score) { score = s; matchedTitle = v; }
  }
  if (metadata.seasonYear && c.year && Number(metadata.seasonYear) === Number(c.year)) score += 15;
  const fmt = String(metadata.format || "").toLowerCase();
  const type = String(c.type || "").toLowerCase();
  if (fmt === "movie" && type.includes("movie")) score += 12;
  if (fmt !== "movie" && (!type || type === "tv")) score += 5;
  return { score: Math.min(score, 120), matchedTitle };
}

async function resolveFromMetadata(metadata: any) {
  const variants = titleVariants(metadata);
  if (!variants.length) return json({ ok: false, error: "Missing anime title metadata" }, 400);

  // Search all useful names, then deduplicate by Anikoto slug.
  const terms = [...new Set(variants)].sort((a, b) => b.length - a.length).slice(0, 8);
  const all = new Map<string, any>();
  for (const term of terms) {
    try {
      for (const c of await anikotoSearch(term)) if (c.slug) all.set(c.slug, c);
    } catch {}
  }

  const ranked = [...all.values()].map(c => ({ ...c, ...scoreCandidate(c, metadata) }))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0] || null;
  const second = ranked[1] || null;
  const confident = !!best && best.score >= 90;
  const ambiguous = !!best && !!second && best.score >= 90 && second.score >= 90 && best.score - second.score < 7;
  const match = confident && !ambiguous ? {
    title: best.title,
    slug: best.slug,
    url: best.url,
    score: best.score,
    matchedTitle: best.matchedTitle,
  } : null;

  return json({
    ok: !!match,
    metadata,
    match,
    alternatives: ranked.slice(0, 10),
    searched: terms,
    reason: !best ? "No Anikoto candidate found" : ambiguous ? "Ambiguous match" : match ? "Exact/high-confidence match" : "No high-confidence match",
  });
}

async function readResolveMetadata(request: Request, url: URL) {
  const input: any = {};
  for (const key of ["title","name","english","romaji","native","userPreferred","synonyms","year","seasonYear","format","episodes","idMal","mal","id","anilist"]) {
    const v = url.searchParams.get(key);
    if (v !== null) input[key] = v;
  }
  if (request.method === "POST") {
    const ct = request.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      try { Object.assign(input, await request.clone().json()); } catch {}
    } else if (ct.includes("form")) {
      try { const f = await request.clone().formData(); for (const [k,v] of f) input[k] = String(v); } catch {}
    }
  }
  return input;
}

function validateTarget(raw: string) {
  let u: URL;
  try { u = new URL(raw); } catch { throw Object.assign(new Error("Invalid target URL"), { status: 400 }); }
  if (!["http:", "https:"].includes(u.protocol)) throw Object.assign(new Error("Only HTTP(S) URLs are supported"), { status: 400 });
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".local")) throw Object.assign(new Error("Local targets are blocked"), { status: 403 });
  return u;
}

function upstreamHeaders(request: Request) {
  const h = new Headers();
  for (const n of ["Accept","Accept-Language","Content-Type","Range","If-None-Match","If-Modified-Since","User-Agent"]) {
    const v = request.headers.get(n); if (v) h.set(n, v);
  }
  return h;
}

function unique(a: string[]) { return [...new Set(a)]; }
function endpoints(text: string, base: string) {
  const out: string[] = [];
  const patterns = [
    /["'`]((?:https?:)?\/\/[^"'`\s<>]+)["'`]/gi,
    /["'`]((?:\/|\.\/|\.\.\/)(?:api|ajax|graphql|search|filter|watch|episode|episodes|stream|source|player|download|proxy)[^"'`\s<>]*)["'`]/gi,
    /["'`]([^"'`\s<>]+\.(?:m3u8|mpd|mp4|m4v|webm)(?:\?[^"'`\s<>]*)?)["'`]/gi,
  ];
  for (const re of patterns) { let m: RegExpExecArray | null; while ((m = re.exec(text))) { const u = abs(m[1], base); if (u) out.push(u); } }
  return unique(out);
}

async function inspectPage(target: URL, request: Request) {
  const h = upstreamHeaders(request);
  h.set("User-Agent", h.get("User-Agent") || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36");
  const r = await fetch(target, { headers: h, redirect: "follow" });
  const ct = r.headers.get("content-type") || "";
  const body = await r.text();
  if (!ct.includes("text/html") && !/<(?:html|script|body)\b/i.test(body)) return json({ ok: true, status: r.status, finalUrl: r.url, contentType: ct, bodyPreview: body.slice(0,2000) });
  const scripts = unique([...body.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map(x => abs(x[1], r.url)).filter(Boolean) as string[]);
  const iframes = unique([...body.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)].map(x => abs(x[1], r.url)).filter(Boolean) as string[]);
  const hrefs = unique([...body.matchAll(/(?:href|action)=["']([^"']+)["']/gi)].map(x => abs(x[1], r.url)).filter(Boolean) as string[]);
  const found = endpoints(body, r.url);
  const assetFindings: any[] = [];
  for (const s of scripts.filter(x => /\.m?js(?:[?#]|$)/i.test(x)).slice(0,12)) {
    try { const ar = await fetch(s, { headers: { "User-Agent": h.get("User-Agent")! } }); const text = await ar.text(); const e = endpoints(text, s); if (e.length) assetFindings.push({ script:s, endpoints:e.slice(0,100) }); } catch {}
  }
  return json({ ok:true, status:r.status, finalUrl:r.url, contentType:ct,
    page:{ title: decodeText(body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ""), size:body.length },
    scripts, iframes, ajaxCalls:[],
    apiEndpoints:found.filter(x => /(?:\/api\/|\/ajax\/|graphql|\.json(?:\?|$))/i.test(x)),
    mediaEndpoints:found.filter(x => /\.(?:m3u8|mpd|mp4|m4v|webm)(?:\?|$)/i.test(x)),
    dataUrls:[], hrefs, javascriptAssetFindings:assetFindings,
    note:"Static inspection only; browser-executed JavaScript requests are not observed by a Worker."
  });
}

async function proxy(url: URL, request: Request) {
  const target = validateTarget(url.searchParams.get("url")!);
  const r = await fetch(target, { method:request.method, headers:upstreamHeaders(request), redirect:"follow", body:["GET","HEAD"].includes(request.method) ? undefined : request.body });
  const h = new Headers();
  for (const n of ["Content-Type","Content-Length","Content-Range","Accept-Ranges","ETag","Last-Modified","Cache-Control","Expires","Location","Content-Encoding"]) { const v=r.headers.get(n); if(v) h.set(n,v); }
  Object.entries(CORS).forEach(([k,v]) => h.set(k,v));
  return new Response(r.body,{status:r.status,statusText:r.statusText,headers:h});
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null,{status:204,headers:CORS});
    try {
      const url = new URL(request.url);

      if (url.pathname === "/resolve") {
        const input = await readResolveMetadata(request,url);
        // Metadata supplied by the app is preferred. AniList is only an optional
        // convenience when the caller supplies no title metadata.
        const supplied = makeMetadata(input);
        if (titleVariants(supplied).length) return await resolveFromMetadata(supplied);
        const id = Number(input.anilist || input.id);
        if (Number.isInteger(id) && id > 0) {
          try { return await resolveFromMetadata(makeMetadata(await getAniListMetadata(id))); }
          catch (e:any) { return json({ok:false,error:e?.message || "AniList lookup failed",hint:"Send anime metadata such as title/romaji/english/year/format instead of relying on AniList."},502); }
        }
        return json({ok:false,error:"Missing anime metadata",expected:{title:"Re:ZERO -Starting Life in Another World-",romaji:"Re:Zero kara Hajimeru Isekai Seikatsu",english:"Re:ZERO -Starting Life in Another World-",synonyms:["Re:Zero"],year:2016,format:"TV",episodes:25}},400);
      }

      if (url.pathname === "/search") {
        const keyword = url.searchParams.get("keyword")?.trim();
        if (!keyword) return json({ok:false,error:"Use ?keyword=<title>"},400);
        const results = await anikotoSearch(keyword);
        return json({ok:true,keyword,count:results.length,results});
      }

      if (url.pathname === "/inspect") {
        const raw=url.searchParams.get("url");
        if(!raw) return json({ok:false,error:"Missing ?url="},400);
        return await inspectPage(validateTarget(raw),request);
      }

      if (url.pathname === "/fetch" || url.pathname === "/proxy" || url.searchParams.has("url")) {
        if(!url.searchParams.has("url")) return json({ok:false,error:"Missing ?url="},400);
        return await proxy(url,request);
      }

      return json({ok:true,service:"Fetcher + metadata → Anikoto resolver",endpoints:{
        resolve:"/resolve?title=<name>&romaji=<romaji>&english=<english>&year=<year>&format=<TV|MOVIE>&episodes=<count>",
        resolvePost:"POST /resolve with JSON metadata",search:"/search?keyword=<title>",inspect:"/inspect?url=<url>",fetch:"/fetch?url=<url>",proxy:"/proxy?url=<url>"
      }});
    } catch(error:any) {
      return json({ok:false,error:error?.message || "Internal error"},error?.status || 500);
    }
  }
};