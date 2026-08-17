# Universal Fetch Worker

A small Cloudflare Worker for testing public HTTP APIs and CDN resources from a browser without repeatedly creating a new proxy.

## Deploy

```bash
npm install -g wrangler
wrangler login
wrangler deploy
```

## Examples

API:

```text
https://YOUR-WORKER.workers.dev/?url=https%3A%2F%2Fexample.com%2Fapi
```

or:

```text
https://YOUR-WORKER.workers.dev/fetch?url=https%3A%2F%2Fexample.com%2Fapi
```

M3U8:

```text
https://YOUR-WORKER.workers.dev/proxy?url=https%3A%2F%2Fcdn.example.com%2Fmaster.m3u8
```

With Referer:

```text
https://YOUR-WORKER.workers.dev/proxy?url=https%3A%2F%2Fcdn.example.com%2Fmaster.m3u8&referer=https%3A%2F%2Fexample.com%2F
```

The worker supports GET/HEAD/POST/PUT/PATCH/DELETE and forwards request bodies for non-GET methods.

Use it only with endpoints/CDNs you are authorized to access.
