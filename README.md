# Cursor Chat

A simple ChatGPT-style web UI that talks to the [Cursor Cloud Agents API](https://cursor.com/docs/cloud-agent/api/endpoints).

## Setup

1. Install [Node.js](https://nodejs.org/) 18 or newer.
2. Open a terminal in `D:\cursor-chat`.
3. Install dependencies:

```bash
npm install
```

4. Your API key is already in `.env`. To change it, edit:

```
CURSOR_API_KEY=your_key_here
PORT=3000
AUTH_USER=your_username
AUTH_PASSWORD=your_password
```

When `AUTH_USER` and `AUTH_PASSWORD` are set, the browser will prompt for credentials before anyone can open the chat or call the API.

## Run

```bash
npm start
```

Open **http://localhost:3000** in your browser.

## Deploy on Vercel

Vercel serves the `public/` folder directly from its CDN, so **Express basic auth in `server.js` does not run** for the HTML/JS unless you also use edge middleware.

This repo includes:

- `middleware.js` — basic auth on Vercel **before** static files are returned
- `api/index.js` + `vercel.json` — API routes and optional full-app routing through Express

**Required:** In the Vercel project → **Settings → Environment Variables**, add (for Production, Preview, and Development):

| Variable | Value |
|----------|--------|
| `CURSOR_API_KEY` | Your Cursor API key |
| `AUTH_USER` | Your login username |
| `AUTH_PASSWORD` | Your login password |
| `CURSOR_INSECURE_TLS` | `1` only if you need it (corporate proxy) |

`.env` is **not** uploaded to Vercel. If these variables are missing, auth is skipped and the site stays public.

Redeploy after saving environment variables.

## How it works

- **Image upload** — attach up to 5 images (PNG, JPEG, GIF, WebP). Paste from clipboard or use the image button. Modified outputs are fetched from agent **artifacts** and shown under the reply.
- **New chat** creates a no-repo Cloud Agent and runs your prompt.
- **Follow-up messages** reuse the same agent (conversation context).
- Responses stream in real time via the API SSE endpoint.
- **Auto** is selected by default — Cursor picks the best model per task.
- Choose another model in the sidebar to pin a specific one (e.g. Opus 4.8).
- Changing the model or clicking **+ New chat** starts a fresh agent (required — follow-up messages cannot change model).

## Security

- Never commit `.env` or share your API key or `AUTH_PASSWORD` publicly.
- Basic auth protects the UI over HTTP; use HTTPS if you expose this beyond localhost.
- If this key was exposed, rotate it in [Cursor Dashboard → API Keys](https://cursor.com/dashboard/api).

## Corporate network / SSL errors

If you see `self-signed certificate in certificate chain`, add to `.env`:

```
CURSOR_INSECURE_TLS=1
```

Only use this on trusted networks. Prefer installing your company root CA into Node instead.

## Notes

- Cloud Agents are designed for coding tasks; for pure Q&A they still work but may occasionally use tools.
- First responses can take longer while the agent VM starts. Image edits may take several minutes; `AGENT_WAIT_MS` (default 5 minutes) controls server wait time. On Vercel Pro, `maxDuration` is set to 300s in `vercel.json`.
- **Fast responses** (sidebar, on by default) uses **Composer 2.5 Fast** for text-only messages — much quicker than Auto/Opus. Turn it off for higher quality or when using images. Start a **new chat** after changing fast mode or model.
- The **first message** in a new chat is slowest (Cloud Agent VM startup). Follow-ups in the same chat are faster.
