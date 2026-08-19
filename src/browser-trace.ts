import puppeteer from "@cloudflare/puppeteer";

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function validateTarget(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw Object.assign(new Error("Invalid target URL"), { status: 400 });
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw Object.assign(new Error("Only HTTP(S) URLs are supported"), { status: 400 });
  }

  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".local")
  ) {
    throw Object.assign(new Error("Local targets are blocked"), { status: 403 });
  }

  return url;
}

export async function browserTrace(
  target: URL,
  query: URL,
  env: { BROWSER: unknown },
): Promise<Response> {
  const waitMs = Math.min(
    Math.max(Number(query.searchParams.get("wait") || 5000), 0),
    15000,
  );

  const maxRequests = Math.min(
    Math.max(Number(query.searchParams.get("max") || 250), 25),
    500,
  );

  const browser = await puppeteer.launch(env.BROWSER as any);

  try {
    const page = await browser.newPage();
    await page.setUserAgent(query.searchParams.get("ua") || DEFAULT_UA);

    const requests: any[] = [];
    const responses: any[] = [];
    const consoleMessages: any[] = [];
    const pageErrors: string[] = [];
    const seenRequests = new Set<string>();

    page.on("request", (request) => {
      if (requests.length >= maxRequests) return;

      const key = `${request.method()} ${request.url()}`;
      if (seenRequests.has(key)) return;
      seenRequests.add(key);

      requests.push({
        method: request.method(),
        url: request.url(),
        resourceType: request.resourceType(),
        navigation: request.isNavigationRequest(),
      });
    });

    page.on("response", (response) => {
      if (responses.length >= maxRequests) return;

      responses.push({
        url: response.url(),
        status: response.status(),
        resourceType: response.request().resourceType(),
        contentType: response.headers()["content-type"] || null,
      });
    });

    page.on("console", (message) => {
      if (consoleMessages.length >= 100) return;
      consoleMessages.push({
        type: message.type(),
        text: message.text().slice(0, 1000),
      });
    });

    page.on("pageerror", (error) => {
      if (pageErrors.length >= 50) return;
      pageErrors.push(String(error).slice(0, 2000));
    });

    const started = Date.now();

    await page.goto(target.toString(), {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    const title = await page.title().catch(() => "");
    const finalUrl = page.url();

    return json({
      ok: true,
      target: target.toString(),
      finalUrl,
      title,
      elapsedMs: Date.now() - started,
      requests,
      responses,
      console: consoleMessages,
      pageErrors,
      note:
        "Runtime network trace from a real headless browser. Request headers, cookies, POST bodies, and credentials are intentionally not returned.",
    });
  } finally {
    await browser.close().catch(() => {});
  }
}
