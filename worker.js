/**
 * Universal Fetch Worker
 *
 * GET:
 *   /?url=https://example.com/api
 *   /fetch?url=https://example.com/api
 *   /proxy?url=https://example.com/file.m3u8&referer=https://example.com/
 *
 * POST/PUT/PATCH/DELETE:
 *   Same URL format. The request body is forwarded.
 *
 * Optional:
 *   ?referer=https://example.com/
 *   ?origin=https://example.com
 *   ?header_Name=value
 *
 * This is intended as a personal API/CDN testing proxy.
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

    if (incoming.pathname === "/") {
      if (!incoming.searchParams.has("url")) {
        return json({
          ok: true,
          service: "Universal Fetch Worker",
          usage: {
            fetch: "/fetch?url=https://example.com/api",
            proxy: "/proxy?url=https://example.com/file.m3u8",
            referer: "/proxy?url=https://example.com/file.m3u8&referer=https://example.com/",
          },
          note: "Use only with endpoints/CDNs you are allowed to access.",
        });
      }
    }

    const target = incoming.searchParams.get("url");

    if (!target) {
      return json({ ok: false, error: "Missing ?url=" }, 400);
    }

    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch {
      return json({ ok: false, error: "Invalid target URL" }, 400);
    }

    if (!["http:", "https:"].includes(targetUrl.protocol)) {
      return json({ ok: false, error: "Only HTTP(S) URLs are supported" }, 400);
    }

    // Prevent obvious local/private targets.
    const hostname = targetUrl.hostname.toLowerCase();
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "0.0.0.0" ||
      hostname.endsWith(".local")
    ) {
      return json({ ok: false, error: "Local targets are blocked" }, 403);
    }

    const headers = new Headers();

    // Forward useful request headers.
    for (const name of [
      "Accept",
      "Accept-Language",
      "Content-Type",
      "Range",
      "If-None-Match",
      "If-Modified-Since",
      "User-Agent",
    ]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }

    const referer = incoming.searchParams.get("referer");
    const origin = incoming.searchParams.get("origin");

    if (referer) headers.set("Referer", referer);
    if (origin) headers.set("Origin", origin);

    // Custom headers: ?header_X-Test=hello
    for (const [key, value] of incoming.searchParams) {
      if (key.toLowerCase().startsWith("header_")) {
        const headerName = key.slice(7);
        if (headerName) headers.set(headerName, value);
      }
    }

    const init = {
      method: request.method,
      headers,
      redirect: "follow",
    };

    if (!["GET", "HEAD"].includes(request.method)) {
      init.body = request.body;
    }

    let upstream;
    try {
      upstream = await fetch(targetUrl.toString(), init);
    } catch (error) {
      return json(
        {
          ok: false,
          error: "Upstream fetch failed",
          message: error instanceof Error ? error.message : String(error),
          target: targetUrl.toString(),
        },
        502
      );
    }

    const responseHeaders = new Headers();

    // Preserve useful upstream response headers.
    for (const name of [
      "Content-Type",
      "Content-Length",
      "Content-Range",
      "Accept-Ranges",
      "ETag",
      "Last-Modified",
      "Cache-Control",
      "Expires",
      "Location",
      "Content-Encoding",
    ]) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }

    for (const [name, value] of Object.entries(CORS)) {
      responseHeaders.set(name, value);
    }

    responseHeaders.set("X-Universal-Proxy-Status", String(upstream.status));
    responseHeaders.set("X-Universal-Proxy-Target", targetUrl.origin);

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  },
};

function json(data, status = 200) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    ...CORS,
  });

  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers,
  });
}
