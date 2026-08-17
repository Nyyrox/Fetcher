/**
 * Universal Fetch Worker
 *
 * GET:
 *   /?url=https://example.com/api
 *   /fetch?url=https://example.com/api
 *   /proxy?url=https://example.com/file.m3u8&referer=https://example.com/
 *   /inspect?url=https://example.com/page
 *
 * /inspect fetches an HTML page and extracts useful network/API clues
 * from the page source and linked JavaScript assets. It does not execute
 * JavaScript or observe a real browser DevTools Network tab.
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Expose-Headers": "*",
};

export default {
  async fetch(request) {
    const incoming = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (incoming.pathname === "/inspect") {
      return inspectPage(incoming);
    }

    if (incoming.pathname === "/") {
      if (!incoming.searchParams.has("url")) {
        return json({
          ok: true,
          service: "Universal Fetch Worker",
          usage: {
            fetch: "/fetch?url=https://example.com/api",
            proxy: "/proxy?url=https://example.com/file.m3u8",
            inspect: "/inspect?url=https://example.com/page",
            referer: "/proxy?url=https://example.com/file.m3u8&referer=https://example.com/",
          },
          note: "Use only with endpoints/CDNs you are allowed to access.",
        });
      }
    }

    const target = incoming.searchParams.get("url");
    if (!target) return json({ ok: false, error: "Missing ?url=" }, 400);

    let targetUrl;
    try {
      targetUrl = validateTarget(target);
    } catch (error) {
      return json({ ok: false, error: error.message }, error.status || 400);
    }

    const headers = buildUpstreamHeaders(incoming, request);
    const init = {
      method: request.method,
      headers,
      redirect: "follow",
    };

    if (!["GET", "HEAD"].includes(request.method)) init.body = request.body;

    let upstream;
    try {
      upstream = await fetch(targetUrl.toString(), init);
    } catch (error) {
      return json({
        ok: false,
        error: "Upstream fetch failed",
        message: error instanceof Error ? error.message : String(error),
        target: targetUrl.toString(),
      }, 502);
    }

    return proxyResponse(upstream, targetUrl);
  },
};

async function inspectPage(incoming) {
  const target = incoming.searchParams.get("url");
  if (!target) return json({ ok: false, error: "Missing ?url=" }, 400);

  let targetUrl;
  try {
    targetUrl = validateTarget(target);
  } catch (error) {
    return json({ ok: false, error: error.message }, error.status || 400);
  }

  const headers = buildUpstreamHeaders(incoming, new Request(incoming.toString()));
  headers.set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
  headers.set("User-Agent", headers.get("User-Agent") || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36");

  let response;
  try {
    response = await fetch(targetUrl.toString(), { method: "GET", headers, redirect: "follow" });
  } catch (error) {
    return json({ ok: false, error: "Upstream fetch failed", message: String(error), target: targetUrl.toString() }, 502);
  }

  const contentType = response.headers.get("content-type") || "";
  const body = await response.text();
  if (!contentType.includes("text/html") && !/<(?:html|head|script|body)\b/i.test(body)) {
    return json({
      ok: true,
      status: response.status,
      finalUrl: response.url,
      contentType,
      note: "Response is not HTML; inspect returned the response metadata only.",
      bodyPreview: body.slice(0, 2000),
    });
  }

  const scripts = unique([
    ...extractMatches(body, /<script[^>]+src=["']([^"']+)["']/gi),
  ].map((src) => resolveUrl(src, response.url)).filter(Boolean));

  const links = unique([
    ...extractMatches(body, /<link[^>]+href=["']([^"']+)["']/gi),
  ].map((href) => resolveUrl(href, response.url)).filter(Boolean));

  const iframes = unique([
    ...extractMatches(body, /<iframe[^>]+src=["']([^"']+)["']/gi),
  ].map((src) => resolveUrl(src, response.url)).filter(Boolean));

  const hrefs = unique(extractMatches(body, /(?:href|action)=["']([^"']+)["']/gi).map((x) => resolveUrl(x, response.url)).filter(Boolean));

  const endpointCandidates = extractEndpointCandidates(body, response.url);
  const apiEndpoints = endpointCandidates.filter((x) => /(?:\/api\/|\/ajax\/|graphql|\.json(?:\?|$))/i.test(x));
  const mediaEndpoints = endpointCandidates.filter((x) => /(?:\.m3u8(?:\?|$)|\.mpd(?:\?|$)|\.mp4(?:\?|$)|\.m4v(?:\?|$)|\.webm(?:\?|$))/i.test(x));
  const ajaxCalls = extractAjaxCalls(body, response.url);
  const dataUrls = extractDataUrls(body, response.url);

  // Inspect linked JS assets for endpoint strings. Limit to 12 assets / 1.5 MB total.
  const jsAssets = scripts.filter((x) => /\.m?js(?:[?#]|$)/i.test(x)).slice(0, 12);
  const assetFindings = [];
  let totalBytes = 0;

  for (const scriptUrl of jsAssets) {
    try {
      const r = await fetch(scriptUrl, { headers: new Headers({ "User-Agent": headers.get("User-Agent") }) });
      const text = await r.text();
      totalBytes += text.length;
      if (totalBytes > 1500000) break;
      const found = unique([
        ...extractEndpointCandidates(text, scriptUrl),
        ...extractAjaxCalls(text, scriptUrl),
      ]);
      if (found.length) assetFindings.push({ script: scriptUrl, endpoints: found.slice(0, 100) });
    } catch {
      // Ignore individual asset failures.
    }
  }

  return json({
    ok: true,
    status: response.status,
    finalUrl: response.url,
    contentType,
    page: {
      title: (body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").trim(),
      size: body.length,
    },
    scripts,
    links: links.slice(0, 100),
    iframes,
    ajaxCalls,
    apiEndpoints: unique(apiEndpoints).slice(0, 200),
    mediaEndpoints: unique(mediaEndpoints).slice(0, 200),
    dataUrls: dataUrls.slice(0, 200),
    hrefs: hrefs.slice(0, 200),
    javascriptAssetFindings: assetFindings,
    note: "This is static inspection of HTML and linked JS. A Worker cannot observe requests made later by browser-executed JavaScript like DevTools Network.",
  });
}

function validateTarget(target) {
  let u;
  try { u = new URL(target); } catch { throw Object.assign(new Error("Invalid target URL"), { status: 400 }); }
  if (!["http:", "https:"].includes(u.protocol)) throw Object.assign(new Error("Only HTTP(S) URLs are supported"), { status: 400 });
  const hostname = u.hostname.toLowerCase();
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "0.0.0.0" || hostname.endsWith(".local")) {
    throw Object.assign(new Error("Local targets are blocked"), { status: 403 });
  }
  return u;
}

function buildUpstreamHeaders(incoming, request) {
  const headers = new Headers();
  for (const name of ["Accept", "Accept-Language", "Content-Type", "Range", "If-None-Match", "If-Modified-Since", "User-Agent"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const referer = incoming.searchParams.get("referer");
  const origin = incoming.searchParams.get("origin");
  if (referer) headers.set("Referer", referer);
  if (origin) headers.set("Origin", origin);
  for (const [key, value] of incoming.searchParams) {
    if (key.toLowerCase().startsWith("header_")) {
      const headerName = key.slice(7);
      if (headerName) headers.set(headerName, value);
    }
  }
  return headers;
}

function extractMatches(text, regex) {
  const out = [];
  let m;
  while ((m = regex.exec(text)) !== null) out.push(m[1]);
  return out;
}

function extractEndpointCandidates(text, baseUrl) {
  const out = [];
  const patterns = [
    /["'`]((?:https?:)?\/\/[^"'`\s<>]+)["'`]/gi,
    /["'`]((?:\/|\.\/|\.\.\/)(?:api|ajax|graphql|search|filter|watch|episode|episodes|stream|source|player|download|proxy)[^"'`\s<>]*)["'`]/gi,
    /["'`]([^"'`\s<>]+\.(?:m3u8|mpd|mp4|m4v|webm)(?:\?[^"'`\s<>]*)?)["'`]/gi,
  ];
  for (const regex of patterns) {
    let m;
    while ((m = regex.exec(text)) !== null) {
      const resolved = resolveUrl(m[1], baseUrl);
      if (resolved) out.push(resolved);
    }
  }
  return unique(out);
}

function extractAjaxCalls(text, baseUrl) {
  const out = [];
  const patterns = [
    /(?:fetch|axios\.(?:get|post)|\$\.ajax|\$\.get|\$\.post|XMLHttpRequest)[\s\S]{0,500}?["'`]((?:https?:)?\/\/[^"'`\s<>]+|(?:\/|\.\/|\.\.\/)[^"'`\s<>]+)["'`]/gi,
  ];
  for (const regex of patterns) {
    let m;
    while ((m = regex.exec(text)) !== null) {
      const resolved = resolveUrl(m[1], baseUrl);
      if (resolved) out.push(resolved);
    }
  }
  return unique(out);
}

function extractDataUrls(text, baseUrl) {
  const out = [];
  const regex = /(?:data-url|data-src|data-api|data-endpoint|data-href)=["']([^"']+)["']/gi;
  let m;
  while ((m = regex.exec(text)) !== null) {
    const resolved = resolveUrl(m[1], baseUrl);
    if (resolved) out.push(resolved);
  }
  return unique(out);
}

function resolveUrl(value, base) {
  if (!value || /^(?:javascript:|mailto:|tel:|#|data:)/i.test(value)) return null;
  try { return new URL(value, base).toString(); } catch { return null; }
}

function unique(values) { return [...new Set(values)]; }

function proxyResponse(upstream, targetUrl) {
  const responseHeaders = new Headers();
  for (const name of ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "ETag", "Last-Modified", "Cache-Control", "Expires", "Location", "Content-Encoding"]) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  for (const [name, value] of Object.entries(CORS)) responseHeaders.set(name, value);
  responseHeaders.set("X-Universal-Proxy-Status", String(upstream.status));
  responseHeaders.set("X-Universal-Proxy-Target", targetUrl.origin);
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
}

function json(data, status = 200) {
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8", ...CORS });
  return new Response(JSON.stringify(data, null, 2), { status, headers });
}
