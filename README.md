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
```

## Run

```bash
npm start
```

Open **http://localhost:3000** in your browser.

## How it works

- **New chat** creates a no-repo Cloud Agent and runs your prompt.
- **Follow-up messages** reuse the same agent (conversation context).
- Responses stream in real time via the API SSE endpoint.
- **Auto** is selected by default — Cursor picks the best model per task.
- Choose another model in the sidebar to pin a specific one (e.g. Opus 4.8).
- Changing the model or clicking **+ New chat** starts a fresh agent (required — follow-up messages cannot change model).

## Security

- Never commit `.env` or share your API key publicly.
- If this key was exposed, rotate it in [Cursor Dashboard → API Keys](https://cursor.com/dashboard/api).

## Corporate network / SSL errors

If you see `self-signed certificate in certificate chain`, add to `.env`:

```
CURSOR_INSECURE_TLS=1
```

Only use this on trusted networks. Prefer installing your company root CA into Node instead.

## Notes

- Cloud Agents are designed for coding tasks; for pure Q&A they still work but may occasionally use tools.
- First responses can take longer while the agent VM starts.
