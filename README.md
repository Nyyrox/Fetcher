# Fetcher API

A Cloudflare Worker for authorized HTTP fetching, HTML/player inspection, JavaScript asset inspection, and CDN/media proxying.

## Home / API docs

`/` is the API documentation home in the site UI.

## Current API

### Fetch
`GET /fetch?url=<url>`

Fetches an HTTP(S) resource and returns its response as JSON metadata/body.

### Proxy
`GET|HEAD /proxy?url=<url>&referer=<url>&origin=<url>`

Proxies an HTTP(S) resource and forwards common media/range headers.

### HTML inspection
`GET /inspect?url=<html-url>`

Extracts scripts, iframes, links, API candidates, media candidates and linked JavaScript clues.

### Player inspection
`GET /inspect-player?url=<player-url>`

Inspects a player page and linked player scripts. It is static and does not execute browser JavaScript.

### Anime resolver
`GET /resolve?...`

Metadata-based Anikoto resolver. Supports the existing title/romaji/English/year/format/episode parameters.

### Anime search
`GET /search?keyword=<title>`

Searches Anikoto and returns normalized candidates.

## Planned/extended inspection helpers

The repository is being expanded with dedicated helpers for extracting inline scripts, inspecting individual JS assets, and extracting page links. These helpers are intentionally read-only and static: they do not execute arbitrary remote JavaScript, bypass DRM/CAPTCHA, or defeat access controls.

## Headers

For upstream requests, use `referer`, `origin`, and `header_<Name>` query parameters where appropriate. The Worker also forwards common request headers such as `Accept`, `Accept-Language`, `Content-Type`, `Range`, `ETag`, and `If-Modified-Since`.

## Deploy

```bash
npm install -g wrangler
wrangler login
wrangler deploy
```

`wrangler.toml` currently uses `src/index.ts` as the Worker entrypoint.

Use only with endpoints/CDNs you are authorized to access.
