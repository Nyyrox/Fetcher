const ANILIST_URL = "https://graphql.anilist.co";
const ANIKOTO_URL = "https://anikototv.to";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Expose-Headers": "*",
};

const ANILIST_QUERY = `
query ($id: Int!) {
  Media(id: $id, type: ANIME) {
    id idMal format episodes seasonYear
    title { romaji english native userPreferred }
    synonyms
  }
}`;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...CORS, "content-type": "application/json; charset=utf-8" },
  });
}

function normalize(value: unknown) {
  return String(value || "")
    .toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\b(the|a|an)\b/g, " ").replace(/\s+/g, " ").trim();
}

function tokens(value: unknown) {
  return new Set(normalize(value).split(" ").filter(x => x.length > 1));
}

function tokenScore(a: string, b: string) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let common = 0;
  for (const x of A) if (B.has(x)) common++;
  return (2 * common) / (A.size + B.size);
}

function slugFromUrl(url: string) {
  try {
    const p = new URL(url).pathname;
    return p.match(/^\/watch\/([^/]+)/i)?.[1] || null;
  } catch { return null; }
}

function titleVariants(media: any) {
  return [media?.title?.english, media?.title?.romaji, media?.title?.native,
    media?.title?.userPreferred, ...(media?.synonyms || [])].filter(Boolean).map(String);
}

async function anilist(id: number) {
  const r = await fetch(ANILIST_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ query: ANILIST_QUERY, variables: { id } }),
  });
  if (!r.ok) throw new Error(`AniList HTTP ${r.status}`);
  const body: any = await r.json();
  if (body.errors?.length) throw new Error(body.errors[0].message || "AniList error");
  return body.data?.Media || null;
}

function resolveUrl(value: string, base: string) {
  try { return new URL(value, base).toString(); } catch { return null; }
}

function cleanHtml(s: string) {
  return s.replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ").trim();
}

/* Handles the current Anikoto search markup and is deliberately tolerant of
   attribute/class ordering changes. */
function parseAnikoto(html: string) {
  const out: any[] = [];
  const itemBlocks = html.match(/<a\b[^>]*class=["'][^"']*\bitem\b[^"']*["'][^>]*>[\s\S]*?<\/a>/gi) || [];
  for (const block of itemBlocks) {
    const href = block.match(/\bhref=["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    const url = resolveUrl(href.replace(/\\\//g, "/"), ANIKOTO_URL);
    if (!url) continue;
    const titleMatch = block.match(/class=["'][^"']*\bd-title\b[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i);
    const dataJp = block.match(/data-jp=["']([^"']*)["']/i)?.[1] || "";
    const title = cleanHtml(titleMatch?.[1] || dataJp);
    const jp = cleanHtml(dataJp);
    const type = cleanHtml(block.match(/<span[^>]*class=["'][^"']*\bdot\b[^"']*["'][^>]*>\s*([^<]+?)\s*<\/span>/i)?.[1] || "");
    const scoreMatch = block.match(/<span[^>]*class=["'][^"']*\bdot\b[^"']*["'][^>]*>[\s\S]*?([0-9]+(?:\.[0-9]+)?)[\s\S]*?<\/span>/i);
    const yearMatch = block.match(/(?:year|release)[^>]*>\s*(\d{4})\s*<\//i);
    out.push({ url, slug: slugFromUrl(url), jp, title, type, score: scoreMatch ? Number(scoreMatch[1]) : null, year: yearMatch?.[1] || null });
  }
  return out.filter(x => x.slug);
}

async function anikotoSearch(keyword: string) {
  const ajax = new URL("/ajax/anime/search", ANIKOTO_URL);
  ajax.searchParams.set("keyword", keyword);
  const headers = {
    Referer: `${ANIKOTO_URL}/`, Origin: ANIKOTO_URL,
    "X-Requested-With": "XMLHttpRequest",
    Accept: "application/json, text/javascript, */*",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
  };
  try {
    const r = await fetch(ajax, { headers });
    if (r.ok) {
      const body: any = await r.json();
      const results = parseAnikoto(body?.result?.html || body?.html || "");
      if (results.length) return results;
    }
  } catch {}

  const page = new URL("/filter/", ANIKOTO_URL);
  page.searchParams.set("keyword", keyword);
  const r = await fetch(page, { headers: { "User-Agent": headers["User-Agent"], Accept: "text/html,*/*" } });
  if (!r.ok) throw new Error(`Anikoto search HTTP ${r.status}`);
  return parseAnikoto(await r.text());
}

function candidateScore(candidate: any, variants: string[], media: any) {
  let best = 0, matchedTitle = "";
  for (const variant of variants) {
    const c = normalize(candidate.title), v = normalize(variant);
    if (!c || !v) continue;
    let score = c === v ? 100 : Math.round(tokenScore(candidate.title, variant) * 80);
    if (score > best) { best = score; matchedTitle = variant; }
  }
  if (media?.seasonYear && candidate.year && Number(media.seasonYear) === Number(candidate.year)) best += 15;
  const format = String(media?.format || "").toLowerCase();
  const type = String(candidate.type || "").toLowerCase();
  if (format === "movie" && type.includes("movie")) best += 10;
  if (format !== "movie" && type === "tv") best += 8;
  return { score: Math.min(best, 120), matchedTitle };
}

async function resolveByAniList(id: number) {
  const media = await anilist(id);
  if (!media) return json({ ok: false, error: "AniList anime not found" }, 404);

  const variants = titleVariants(media);
  const searchTerms = [...new Set(variants)].sort((a, b) => b.length - a.length).slice(0, 8);
  const all = new Map<string, any>();
  for (const term of searchTerms) {
    try {
      for (const c of await anikotoSearch(term)) if (c.slug) all.set(c.slug, c);
    } catch {}
  }

  const ranked = [...all.values()].map(c => ({ ...c, ...candidateScore(c, variants, media) }))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0] || null;
  const second = ranked[1] || null;
  const confident = !!best && best.score >= 90;
  const ambiguous = !!best && !!second && best.score >= 90 && second.score >= 90 && best.score - second.score < 8;
  const match = confident && !ambiguous ? { title: best.title, slug: best.slug, url: best.url, score: best.score, matchedTitle: best.matchedTitle } : null;

  return json({
    ok: !!match,
    anilist: { id: media.id, idMal: media.idMal, format: media.format, episodes: media.episodes, seasonYear: media.seasonYear, title: media.title, synonyms: media.synonyms },
    match,
    alternatives: ranked.slice(0, 10),
    searched: searchTerms,
    reason: !best ? "No Anikoto candidate found" : ambiguous ? "Ambiguous match" : match ? "Exact/high-confidence match" : "No high-confidence match",
  });
}

/* ---------- Universal fetch / inspect compatibility ---------- */
function validateTarget(target: string) {
  let u: URL;
  try { u = new URL(target); } catch { throw Object.assign(new Error("Invalid target URL"), { status: 400 }); }
  if (!["http:", "https:"].includes(u.protocol)) throw Object.assign(new Error("Only HTTP(S) URLs are supported"), { status: 400 });
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "0.0.0.0" || h.endsWith(".local")) throw Object.assign(new Error("Local targets are blocked"), { status: 403 });
  return u;
}

function upstreamHeaders(url: URL, request: Request) {
  const h = new Headers();
  for (const n of ["Accept", "Accept-Language", "Content-Type", "Range", "If-None-Match", "If-Modified-Since", "User-Agent"]) {
    const v = request.headers.get(n); if (v) h.set(n, v);
  }
  const referer = url.searchParams.get("referer"), origin = url.searchParams.get("origin");
  if (referer) h.set("Referer", referer);
  if (origin) h.set("Origin", origin);
  for (const [k, v] of url.searchParams) if (k.toLowerCase().startsWith("header_")) h.set(k.slice(7), v);
  return h;
}

function unique(a: string[]) { return [...new Set(a)]; }
function extractMatches(text: string, re: RegExp) { const out: string[] = []; let m; while ((m = re.exec(text))) out.push(m[1]); return out; }
function extractEndpoints(text: string, base: string) {
  const out: string[] = [];
  const patterns = [
    /["'`]((?:https?:)?\/\/[^"'`\s<>]+)["'`]/gi,
    /["'`]((?:\/|\.\/|\.\.\/)(?:api|ajax|graphql|search|filter|watch|episode|episodes|stream|source|player|download|proxy)[^"'`\s<>]*)["'`]/gi,
    /["'`]([^"'`\s<>]+\.(?:m3u8|mpd|mp4|m4v|webm)(?:\?[^"'`\s<>]*)?)["'`]/gi,
  ];
  for (const re of patterns) for (const x of extractMatches(text, re)) { const u = resolveUrl(x, base); if (u) out.push(u); }
  return unique(out);
}

async function inspectPage(target: URL, request: Request) {
  const h = upstreamHeaders(target, request);
  h.set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
  h.set("User-Agent", h.get("User-Agent") || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36");
  const r = await fetch(target, { headers: h, redirect: "follow" });
  const ct = r.headers.get("content-type") || "", body = await r.text();
  if (!ct.includes("text/html") && !/<(?:html|head|script|body)\b/i.test(body)) return json({ ok: true, status: r.status, finalUrl: r.url, contentType: ct, note: "Response is not HTML; inspect returned the response metadata only.", bodyPreview: body.slice(0, 2000) });
  const scripts = unique(extractMatches(body, /<script[^>]+src=["']([^"']+)["']/gi).map(x => resolveUrl(x, r.url)).filter(Boolean) as string[]);
  const links = unique(extractMatches(body, /<link[^>]+href=["']([^"']+)["']/gi).map(x => resolveUrl(x, r.url)).filter(Boolean) as string[]);
  const iframes = unique(extractMatches(body, /<iframe[^>]+src=["']([^"']+)["']/gi).map(x => resolveUrl(x, r.url)).filter(Boolean) as string[]);
  const hrefs = unique(extractMatches(body, /(?:href|action)=["']([^"']+)["']/gi).map(x => resolveUrl(x, r.url)).filter(Boolean) as string[]);
  const assetFindings: any[] = [];
  let bytes = 0;
  for (const s of scripts.filter(x => /\.m?js(?:[?#]|$)/i.test(x)).slice(0, 12)) {
    try { const ar = await fetch(s, { headers: { "User-Agent": h.get("User-Agent")! } }); const text = await ar.text(); bytes += text.length; if (bytes > 1500000) break; const found = extractEndpoints(text, s); if (found.length) assetFindings.push({ script: s, endpoints: found.slice(0, 100) }); } catch {}
  }
  const endpoints = extractEndpoints(body, r.url);
  return json({ ok: true, status: r.status, finalUrl: r.url, contentType: ct,
    page: { title: (body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").trim(), size: body.length },
    scripts, links: links.slice(0, 100), iframes, ajaxCalls: [],
    apiEndpoints: endpoints.filter(x => /(?:\/api\/|\/ajax\/|graphql|\.json(?:\?|$))/i.test(x)).slice(0, 200),
    mediaEndpoints: endpoints.filter(x => /\.(?:m3u8|mpd|mp4|m4v|webm)(?:\?|$)/i.test(x)).slice(0, 200),
    dataUrls: [], hrefs: hrefs.slice(0, 200), javascriptAssetFindings: assetFindings,
    note: "Static inspection only; browser-executed JavaScript requests are not observed by a Worker."
  });
}

async function universalFetch(url: URL, request: Request) {
  const target = validateTarget(url.searchParams.get("url")!);
  const r = await fetch(target, { method: request.method, headers: upstreamHeaders(url, request), redirect: "follow", body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body });
  const h = new Headers();
  for (const n of ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "ETag", "Last-Modified", "Cache-Control", "Expires", "Location", "Content-Encoding"]) { const v = r.headers.get(n); if (v) h.set(n, v); }
  Object.entries(CORS).forEach(([k, v]) => h.set(k, v));
  h.set("X-Universal-Proxy-Status", String(r.status)); h.set("X-Universal-Proxy-Target", target.origin);
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    try {
      const url = new URL(request.url);
      if (url.pathname === "/resolve") {
        const id = Number(url.searchParams.get("anilist"));
        if (!Number.isInteger(id) || id <= 0) return json({ ok: false, error: "Use ?anilist=<AniList ID>" }, 400);
        return await resolveByAniList(id);
      }
      if (url.pathname === "/search") {
        const keyword = url.searchParams.get("keyword")?.trim();
        if (!keyword) return json({ ok: false, error: "Use ?keyword=<title>" }, 400);
        const results = await anikotoSearch(keyword);
        return json({ ok: true, keyword, count: results.length, results });
      }
      if (url.pathname === "/inspect") {
        const raw = url.searchParams.get("url");
        if (!raw) return json({ ok: false, error: "Missing ?url=" }, 400);
        return await inspectPage(validateTarget(raw), request);
      }
      if (url.pathname === "/fetch" || url.pathname === "/proxy" || url.searchParams.has("url")) {
        if (!url.searchParams.has("url")) return json({ ok: false, error: "Missing ?url=" }, 400);
        return await universalFetch(url, request);
      }
      return json({ ok: true, service: "Fetcher + AniList → Anikoto resolver", endpoints: {
        resolve: "/resolve?anilist=<id>", search: "/search?keyword=<title>", inspect: "/inspect?url=<url>",
        fetch: "/fetch?url=<url>", proxy: "/proxy?url=<url>"
      }});
    } catch (error: any) {
      return json({ ok: false, error: error?.message || "Internal error" }, error?.status || 500);
    }
  }
};