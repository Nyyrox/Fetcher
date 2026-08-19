/**
 * Universal Fetch Worker
 *
 * Read-only HTTP inspection/fetch helper for public resources you are
 * authorized to access. Browser JavaScript is NOT executed here.
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Expose-Headers": "*",
};

const DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36";
const MAX_TEXT = 2_000_000;
const MAX_SCRIPTS = 20;

export default {
  async fetch(request) {
    const incoming = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    try {
      if (incoming.pathname === "/docs" || incoming.pathname === "/api-docs") return docs();
      if (incoming.pathname === "/health") return json({ ok: true, service: "Universal Fetch Worker", version: "2.0" });
      if (incoming.pathname === "/inspect") return inspectPage(incoming);
      if (incoming.pathname === "/inspect-player") return inspectPlayer(incoming);
      if (incoming.pathname === "/extract-inline-js") return extractInlineJs(incoming);
      if (incoming.pathname === "/inspect-script") return inspectScript(incoming);
      if (incoming.pathname === "/extract-links") return extractLinks(incoming);

      if (incoming.pathname === "/" && !incoming.searchParams.has("url")) return docs();

      const target = incoming.searchParams.get("url");
      if (!target) return json({ ok: false, error: "Missing ?url=" }, 400);
      const targetUrl = validateTarget(target);
      const headers = buildUpstreamHeaders(incoming, request);
      const init = { method: request.method, headers, redirect: "follow" };
      if (!["GET", "HEAD"].includes(request.method)) init.body = request.body;
      const upstream = await fetch(targetUrl.toString(), init);
      return proxyResponse(upstream, targetUrl);
    } catch (error) {
      return json({ ok: false, error: error?.message || String(error) }, error?.status || 502);
    }
  },
};

function docs() {
  return json({
    ok: true,
    service: "Universal Fetch Worker",
    version: "2.0",
    endpoints: {
      fetch: "/fetch?url=<url>",
      proxy: "/proxy?url=<url>&referer=<referer>&origin=<origin>",
      inspect: "/inspect?url=<html-url>",
      inspectPlayer: "/inspect-player?url=<player-url>",
      extractInlineJs: "/extract-inline-js?url=<html-url>",
      inspectScript: "/inspect-script?url=<js-url>",
      extractLinks: "/extract-links?url=<html-url>",
      health: "/health",
      docs: "/docs",
    },
    headers: "Pass header_<Name>=<value>, plus referer/origin, when the upstream permits it.",
    limits: { maxTextBytes: MAX_TEXT, maxScripts: MAX_SCRIPTS },
    note: "Static inspection does not execute browser JavaScript, solve CAPTCHA, bypass DRM, or defeat access controls. Use only with resources you are authorized to access."
  });
}

async function inspectPage(incoming) {
  const { targetUrl, headers, response, body } = await fetchTextTarget(incoming);
  if (!isHtml(response, body)) return nonHtml(response, body);
  return buildInspection(response, body, headers);
}

async function inspectPlayer(incoming) {
  const result = await fetchTextTarget(incoming);
  if (!isHtml(result.response, result.body)) return nonHtml(result.response, result.body);
  const data = buildInspection(result.response, result.body, result.headers);
  data.playerScripts = data.scripts.filter(x => /(?:player|watch|stream|imdb|video|blocker|assets)/i.test(x));
  data.playerMarkup = [...data.scripts, ...data.iframes];
  data.inlineEndpoints = data.inlineEndpoints || findInteresting(result.body, result.response.url);
  data.note = "Static player inspection only. Runtime browser requests require a real browser/network capture.";
  return json(data);
}

async function extractInlineJs(incoming) {
  const result = await fetchTextTarget(incoming);
  if (!isHtml(result.response, result.body)) return nonHtml(result.response, result.body);
  const scripts = extractInlineScripts(result.body).map((content, index) => ({
    index,
    length: content.length,
    matches: findInteresting(content, result.response.url),
    content: content.slice(0, 500000),
  }));
  return json({ ok: true, status: result.response.status, finalUrl: result.response.url, pageSize: result.body.length, count: scripts.length, scripts });
}

async function inspectScript(incoming) {
  const result = await fetchTextTarget(incoming);
  const text = result.body;
  return json({
    ok: true,
    status: result.response.status,
    finalUrl: result.response.url,
    contentType: result.response.headers.get("content-type") || "",
    size: text.length,
    matches: findInteresting(text, result.response.url),
    preview: text.slice(0, 500000),
  });
}

async function extractLinks(incoming) {
  const result = await fetchTextTarget(incoming);
  if (!isHtml(result.response, result.body)) return nonHtml(result.response, result.body);
  const body = result.body;
  return json({
    ok: true,
    status: result.response.status,
    finalUrl: result.response.url,
    scripts: unique(extractMatches(body, /<script[^>]+src=["']([^"']+)["']/gi).map(x => resolveUrl(x, result.response.url)).filter(Boolean)),
    iframes: unique(extractMatches(body, /<iframe[^>]+src=["']([^"']+)["']/gi).map(x => resolveUrl(x, result.response.url)).filter(Boolean)),
    links: unique(extractMatches(body, /<link[^>]+href=["']([^"']+)["']/gi).map(x => resolveUrl(x, result.response.url)).filter(Boolean)),
    hrefs: unique(extractMatches(body, /(?:href|action)=["']([^"']+)["']/gi).map(x => resolveUrl(x, result.response.url)).filter(Boolean)),
    inlineScripts: extractInlineScripts(body).map((x, i) => ({ index: i, length: x.length, matches: findInteresting(x, result.response.url) })),
  });
}

async function fetchTextTarget(incoming) {
  const target = incoming.searchParams.get("url");
  if (!target) throw Object.assign(new Error("Missing ?url="), { status: 400 });
  const targetUrl = validateTarget(target);
  const headers = buildUpstreamHeaders(incoming, new Request(incoming.toString()));
  headers.set("Accept", "text/html,application/xhtml+xml,application/javascript,text/javascript,application/json;q=0.9,*/*;q=0.8");
  headers.set("User-Agent", headers.get("User-Agent") || DEFAULT_UA);
  const response = await fetch(targetUrl.toString(), { method: "GET", headers, redirect: "follow" });
  const body = (await response.text()).slice(0, MAX_TEXT);
  return { targetUrl, headers, response, body };
}

function buildInspection(response, body, headers) {
  const scripts = unique(extractMatches(body, /<script[^>]+src=["']([^"']+)["']/gi).map(x => resolveUrl(x, response.url)).filter(Boolean));
  const links = unique(extractMatches(body, /<link[^>]+href=["']([^"']+)["']/gi).map(x => resolveUrl(x, response.url)).filter(Boolean));
  const iframes = unique(extractMatches(body, /<iframe[^>]+src=["']([^"']+)["']/gi).map(x => resolveUrl(x, response.url)).filter(Boolean));
  const hrefs = unique(extractMatches(body, /(?:href|action)=["']([^"']+)["']/gi).map(x => resolveUrl(x, response.url)).filter(Boolean));
  const candidates = extractEndpointCandidates(body, response.url);
  const ajaxCalls = extractAjaxCalls(body, response.url);
  const apiEndpoints = candidates.filter(x => /(?:\/api\/|\/ajax\/|graphql|\.json(?:\?|$))/i.test(x));
  const mediaEndpoints = candidates.filter(x => /(?:\.m3u8(?:\?|$)|\.mpd(?:\?|$)|\.mp4(?:\?|$)|\.m4v(?:\?|$)|\.webm(?:\?|$))/i.test(x));
  const assetFindings = [];
  let total = 0;
  for (const scriptUrl of scripts.filter(x => /\.m?js(?:[?#]|$)/i.test(x)).slice(0, MAX_SCRIPTS)) {
    // Don't execute JS. We only read publicly linked text assets.
    fetch(scriptUrl, { headers: new Headers({ "User-Agent": headers.get("User-Agent") || DEFAULT_UA }) }).then(async r => ({ r, text: await r.text() })).then(({ r, text }) => {
      void r; void text;
    }).catch(() => {});
  }
  // Asset scanning is deliberately omitted from this synchronous response; use /inspect-script on assets.
  const inline = extractInlineScripts(body);
  return {
    ok: true,
    status: response.status,
    finalUrl: response.url,
    contentType: response.headers.get("content-type") || "",
    page: { title: (body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").trim(), size: body.length },
    scripts, links: links.slice(0, 100), iframes, ajaxCalls,
    apiEndpoints: unique(apiEndpoints).slice(0, 200),
    mediaEndpoints: unique(mediaEndpoints).slice(0, 200),
    dataUrls: extractDataUrls(body, response.url).slice(0, 200),
    hrefs: hrefs.slice(0, 200),
    inlineScripts: inline.map((x, i) => ({ index: i, length: x.length, matches: findInteresting(x, response.url) })),
    inlineEndpoints: findInteresting(body, response.url),
    note: "Static inspection only; browser-executed JavaScript requests are not observed."
  };
}

function findInteresting(text, baseUrl) {
  const out = [];
  const needles = ["/v1/sources", "/sources/stream", "/server/stream", "session", "fetch(", "XMLHttpRequest", "m3u8", "mpd", ".mp4", "torrent", "tmdb", "imdb"];
  for (const needle of needles) {
    let at = 0, count = 0;
    while ((at = text.toLowerCase().indexOf(needle.toLowerCase(), at)) !== -1 && count++ < 10) {
      out.push({ needle, context: text.slice(Math.max(0, at - 220), Math.min(text.length, at + needle.length + 420)) });
      at += needle.length;
    }
  }
  return out;
}

function extractInlineScripts(body) {
  const out = [];
  const re = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(body)) !== null) if (m[1].trim()) out.push(m[1]);
  return out;
}

function validateTarget(target) {
  let u;
  try { u = new URL(target); } catch { throw Object.assign(new Error("Invalid target URL"), { status: 400 }); }
  if (!["http:", "https:"].includes(u.protocol)) throw Object.assign(new Error("Only HTTP(S) URLs are supported"), { status: 400 });
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "0.0.0.0" || h.endsWith(".local")) throw Object.assign(new Error("Local targets are blocked"), { status: 403 });
  return u;
}

function buildUpstreamHeaders(incoming, request) {
  const headers = new Headers();
  for (const name of ["Accept", "Accept-Language", "Content-Type", "Range", "If-None-Match", "If-Modified-Since", "User-Agent", "Cookie"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const referer = incoming.searchParams.get("referer");
  const origin = incoming.searchParams.get("origin");
  if (referer) headers.set("Referer", referer);
  if (origin) headers.set("Origin", origin);
  for (const [key, value] of incoming.searchParams) {
    if (key.toLowerCase().startsWith("header_")) {
      const name = key.slice(7);
      if (name) headers.set(name, value);
    }
  }
  if (!headers.has("User-Agent")) headers.set("User-Agent", DEFAULT_UA);
  return headers;
}

function extractMatches(text, regex) { const out=[]; let m; while ((m=regex.exec(text))!==null) out.push(m[1]); return out; }
function extractEndpointCandidates(text, baseUrl) {
  const out=[]; const patterns=[/["'`]((?:https?:)?\/\/[^"'`\s<>]+)["'`]/gi,/["'`]((?:\/|\.\/|\.\.\/)(?:api|ajax|graphql|search|filter|watch|episode|episodes|stream|source|player|download|proxy)[^"'`\s<>]*)["'`]/gi,/["'`]([^"'`\s<>]+\.(?:m3u8|mpd|mp4|m4v|webm)(?:\?[^"'`\s<>]*)?)["'`]/gi]; for(const re of patterns){let m;while((m=re.exec(text))!==null){const u=resolveUrl(m[1],baseUrl);if(u)out.push(u)}} return unique(out);
}
function extractAjaxCalls(text, baseUrl) { const out=[]; const re=/(?:fetch|axios\.(?:get|post)|\$\.ajax|\$\.get|\$\.post|XMLHttpRequest)[\s\S]{0,500}?["'`]((?:https?:)?\/\/[^"'`\s<>]+|(?:\/|\.\/|\.\.\/)[^"'`\s<>]+)["'`]/gi; let m; while((m=re.exec(text))!==null){const u=resolveUrl(m[1],baseUrl);if(u)out.push(u)} return unique(out); }
function extractDataUrls(text, baseUrl) { const out=[]; const re=/(?:data-url|data-src|data-api|data-endpoint|data-href)=["']([^"']+)["']/gi; let m; while((m=re.exec(text))!==null){const u=resolveUrl(m[1],baseUrl);if(u)out.push(u)} return unique(out); }
function resolveUrl(value, base) { if(!value || /^(?:javascript:|mailto:|tel:|#|data:)/i.test(value)) return null; try{return new URL(value,base).toString()}catch{return null} }
function unique(values){return [...new Set(values)]}
function isHtml(response, body){return (response.headers.get("content-type")||"").includes("text/html") || /<(?:html|head|script|body)\b/i.test(body)}
function nonHtml(response, body){return json({ok:true,status:response.status,finalUrl:response.url,contentType:response.headers.get("content-type")||"",bodyPreview:body.slice(0,2000),note:"Response is not HTML."})}
function proxyResponse(upstream,targetUrl){const h=new Headers();for(const n of ["Content-Type","Content-Length","Content-Range","Accept-Ranges","ETag","Last-Modified","Cache-Control","Expires","Location","Content-Encoding"]){const v=upstream.headers.get(n);if(v)h.set(n,v)}for(const [n,v] of Object.entries(CORS))h.set(n,v);h.set("X-Universal-Proxy-Status",String(upstream.status));h.set("X-Universal-Proxy-Target",targetUrl.origin);return new Response(upstream.body,{status:upstream.status,statusText:upstream.statusText,headers:h})}
function json(data,status=200){return new Response(JSON.stringify(data,null,2),{status,headers:new Headers({"Content-Type":"application/json; charset=utf-8",...CORS})})}
