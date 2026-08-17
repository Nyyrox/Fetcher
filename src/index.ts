const ANILIST_URL = "https://graphql.anilist.co";
const ANIKOTO_URL = "https://anikototv.to";

const ANILIST_QUERY = `
query ($id: Int!) {
  Media(id: $id, type: ANIME) {
    id
    idMal
    format
    episodes
    seasonYear
    title { romaji english native userPreferred }
    synonyms
  }
}`;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...cors, "content-type": "application/json; charset=utf-8" },
  });
}

function normalize(value: unknown) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\b(the|a|an)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenScore(a: string, b: string) {
  const A = new Set(normalize(a).split(" ").filter(x => x.length > 1));
  const B = new Set(normalize(b).split(" ").filter(x => x.length > 1));
  if (!A.size || !B.size) return 0;
  let common = 0;
  for (const token of A) if (B.has(token)) common++;
  return (2 * common) / (A.size + B.size);
}

function slugFromUrl(url: string) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/^\/watch\/([^/]+)/i);
    return m?.[1] || null;
  } catch {
    return null;
  }
}

function titleVariants(media: any) {
  return [
    media?.title?.english,
    media?.title?.romaji,
    media?.title?.native,
    media?.title?.userPreferred,
    ...(Array.isArray(media?.synonyms) ? media.synonyms : []),
  ].filter(Boolean).map(String);
}

function candidateScore(candidate: any, variants: string[], media: any) {
  let best = 0;
  let matchedTitle = "";
  const candidateTitle = String(candidate.title || "");
  const c = normalize(candidateTitle);

  for (const variant of variants) {
    const v = normalize(variant);
    if (!v) continue;
    if (c === v) {
      if (100 > best) { best = 100; matchedTitle = variant; }
      continue;
    }
    const score = Math.round(tokenScore(candidateTitle, variant) * 80);
    if (score > best) { best = score; matchedTitle = variant; }
  }

  if (media?.seasonYear && candidate.year && Number(media.seasonYear) === Number(candidate.year)) best += 15;

  const format = String(media?.format || "").toLowerCase();
  const type = String(candidate.type || "").toLowerCase();
  if (format === "movie" && type === "movie") best += 10;
  if (format !== "movie" && type === "tv") best += 8;

  return { score: Math.min(best, 120), matchedTitle };
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

async function anikotoSearch(keyword: string) {
  const url = new URL("/ajax/anime/search", ANIKOTO_URL);
  url.searchParams.set("keyword", keyword);

  const r = await fetch(url, {
    headers: {
      Referer: `${ANIKOTO_URL}/`,
      Origin: ANIKOTO_URL,
      "X-Requested-With": "XMLHttpRequest",
      Accept: "application/json, text/javascript, */*",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  if (!r.ok) throw new Error(`Anikoto HTTP ${r.status}`);
  const body: any = await r.json();
  const html = body?.result?.html || "";
  return parseAnikoto(html);
}

function parseAnikoto(html: string) {
  const out: any[] = [];
  const itemRe = /<a\s+class=["']item["']\s+href=["']([^"']+)["'][\s\S]*?<div\s+class=["']name d-title["'][^>]*data-jp=["']([^"']*)["'][^>]*>([\s\S]*?)<\/div>[\s\S]*?<span\s+class=["']dot["']>([^<]*)<\/span>[\s\S]*?<span\s+class=["']dot["'][^>]*>[\s\S]*?([0-9.]+)[\s\S]*?<\/span>[\s\S]*?<span\s+class=["']dot["']>([^<]*)<\/span>\s*<span\s+class=["']dot["']>([^<]*)<\/span>/gi;

  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(html))) {
    const clean = (s: string) => s.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").trim();
    const href = m[1].replace(/\\\//g, "/");
    out.push({
      url: href.startsWith("http") ? href : new URL(href, ANIKOTO_URL).href,
      slug: slugFromUrl(href.startsWith("http") ? href : new URL(href, ANIKOTO_URL).href),
      jp: clean(m[2]),
      title: clean(m[3]),
      rating: clean(m[4]),
      score: Number(m[5]),
      type: clean(m[6]),
      year: clean(m[7]),
    });
  }

  return out;
}

async function resolveByAniList(id: number) {
  const media = await anilist(id);
  if (!media) return json({ ok: false, error: "AniList anime not found" }, 404);

  const variants = titleVariants(media);
  const searchTerms = [...new Set(variants)].sort((a, b) => b.length - a.length).slice(0, 5);
  const all = new Map<string, any>();

  for (const term of searchTerms) {
    try {
      const candidates = await anikotoSearch(term);
      for (const candidate of candidates) {
        if (candidate.slug) all.set(candidate.slug, candidate);
      }
    } catch {}
  }

  const ranked = [...all.values()]
    .map(candidate => ({
      ...candidate,
      ...candidateScore(candidate, variants, media),
    }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0] || null;
  const confident = !!best && best.score >= 90;
  const ambiguous = !!best && ranked[1] && best.score - ranked[1].score < 8 && ranked[1].score >= 90;

  return json({
    ok: confident && !ambiguous,
    anilist: {
      id: media.id,
      idMal: media.idMal,
      format: media.format,
      episodes: media.episodes,
      seasonYear: media.seasonYear,
      title: media.title,
      synonyms: media.synonyms,
    },
    match: confident && !ambiguous ? {
      title: best.title,
      slug: best.slug,
      url: best.url,
      score: best.score,
      matchedTitle: best.matchedTitle,
    } : null,
    alternatives: ranked.slice(0, 10),
    searched: searchTerms,
    reason: !best ? "No Anikoto candidate found" : ambiguous ? "Ambiguous match" : confident ? "Exact/high-confidence match" : "No high-confidence match",
  });
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      const url = new URL(request.url);

      if (url.pathname === "/resolve") {
        const id = Number(url.searchParams.get("anilist"));
        if (!Number.isInteger(id) || id <= 0) return json({ ok: false, error: "Use ?anilist=<AniList ID>" }, 400);
        return resolveByAniList(id);
      }

      if (url.pathname === "/search") {
        const keyword = url.searchParams.get("keyword")?.trim();
        if (!keyword) return json({ ok: false, error: "Use ?keyword=<title>" }, 400);
        const results = await anikotoSearch(keyword);
        return json({ ok: true, keyword, count: results.length, results });
      }

      return json({ ok: true, service: "AniList → Anikoto resolver", endpoints: {
        resolve: "/resolve?anilist=<id>",
        search: "/search?keyword=<title>",
      }});
    } catch (error: any) {
      return json({ ok: false, error: error?.message || "Internal error" }, 500);
    }
  },
};
