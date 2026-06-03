require("dotenv").config();

const crypto = require("crypto");

if (process.env.CURSOR_INSECURE_TLS === "1") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const express = require("express");
const path = require("path");

const API_BASE = "https://api.cursor.com";
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.CURSOR_API_KEY;
const AUTH_USER = process.env.AUTH_USER;
const AUTH_PASSWORD = process.env.AUTH_PASSWORD;
// Cursor "Auto" routing — use id "auto" (alias of "default"). Omitting model uses account default (e.g. Opus).
const DEFAULT_MODEL_ID = process.env.CURSOR_DEFAULT_MODEL || "auto";

function timingSafeEqual(a, b) {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) {
    crypto.timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function requireBasicAuth(req, res, next) {
  if (!AUTH_USER || !AUTH_PASSWORD) {
    return next();
  }

  const header = req.headers.authorization;
  if (!header || !header.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Cursor Chat"');
    return res.status(401).send("Authentication required");
  }

  let decoded;
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    res.setHeader("WWW-Authenticate", 'Basic realm="Cursor Chat"');
    return res.status(401).send("Authentication required");
  }

  const colon = decoded.indexOf(":");
  if (colon === -1) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Cursor Chat"');
    return res.status(401).send("Authentication required");
  }

  const user = decoded.slice(0, colon);
  const pass = decoded.slice(colon + 1);

  if (timingSafeEqual(user, AUTH_USER) && timingSafeEqual(pass, AUTH_PASSWORD)) {
    return next();
  }

  res.setHeader("WWW-Authenticate", 'Basic realm="Cursor Chat"');
  return res.status(401).send("Invalid credentials");
}

function resolveModel(modelId) {
  const id = (modelId || DEFAULT_MODEL_ID).trim();
  if (id === "default" || id === "auto") {
    return { id: "auto" };
  }
  return { id };
}

if (!API_KEY) {
  console.error("Missing CURSOR_API_KEY in .env");
  process.exit(1);
}

const app = express();
app.use(requireBasicAuth);
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

function authHeaders() {
  return {
    Authorization: `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
  };
}

async function apiFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { ...authHeaders(), ...options.headers },
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(data?.message || data?.error || res.statusText);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function waitForRunIdle(agentId, maxWaitMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const agent = await apiFetch(`${API_BASE}/v1/agents/${agentId}`);
    if (!agent.latestRunId) return;
    const run = await apiFetch(
      `${API_BASE}/v1/agents/${agentId}/runs/${agent.latestRunId}`
    );
    const busy = run.status === "CREATING" || run.status === "RUNNING";
    if (!busy) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("Agent is still busy. Try again in a moment.");
}

app.get("/api/health", async (_req, res) => {
  try {
    const me = await apiFetch(`${API_BASE}/v1/me`);
    res.json({ ok: true, me });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message, details: e.data });
  }
});

app.get("/api/models", async (_req, res) => {
  try {
    const data = await apiFetch(`${API_BASE}/v1/models`);
    res.json(data);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, details: e.data });
  }
});

app.post("/api/chat", async (req, res) => {
  const { message, agentId, modelId } = req.body || {};
  if (!message || !String(message).trim()) {
    return res.status(400).json({ error: "message is required" });
  }

  try {
    let agent;
    let run;

    if (agentId) {
      await waitForRunIdle(agentId);
      const data = await apiFetch(`${API_BASE}/v1/agents/${agentId}/runs`, {
        method: "POST",
        body: JSON.stringify({
          prompt: { text: String(message).trim() },
        }),
      });
      run = data.run;
      agent = { id: agentId };
    } else {
      const body = {
        prompt: {
          text: `You are a helpful assistant in a chat interface. Answer clearly and conversationally. Do not write code or use tools unless the user explicitly asks for implementation help.\n\nUser: ${String(message).trim()}`,
        },
        name: "Chat",
      };
      const model = resolveModel(modelId);
      body.model = model;
      const data = await apiFetch(`${API_BASE}/v1/agents`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      agent = data.agent;
      run = data.run;
    }

    res.json({
      agentId: agent.id,
      runId: run.id,
      status: run.status,
      modelId: resolveModel(modelId).id,
      reusedAgent: Boolean(agentId),
    });
  } catch (e) {
    res.status(e.status || 500).json({
      error: e.message,
      details: e.data,
    });
  }
});

app.get("/api/chat/:agentId/runs/:runId/stream", async (req, res) => {
  const { agentId, runId } = req.params;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const streamUrl = `${API_BASE}/v1/agents/${agentId}/runs/${runId}/stream`;

  try {
    const upstream = await fetch(streamUrl, {
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        Accept: "text/event-stream",
      },
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      res.write(
        `event: error\ndata: ${JSON.stringify({ message: errText || upstream.statusText })}\n\n`
      );
      res.end();
      return;
    }

    if (!upstream.body) {
      res.write(
        `event: error\ndata: ${JSON.stringify({ message: "No stream body" })}\n\n`
      );
      res.end();
      return;
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();

    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(decoder.decode(value, { stream: true }));
      }
      res.end();
    };

    req.on("close", () => reader.cancel().catch(() => {}));
    await pump();
  } catch (e) {
    if (!res.writableEnded) {
      res.write(
        `event: error\ndata: ${JSON.stringify({ message: e.message })}\n\n`
      );
      res.end();
    }
  }
});

app.get("/api/chat/:agentId/runs/:runId", async (req, res) => {
  try {
    const data = await apiFetch(
      `${API_BASE}/v1/agents/${req.params.agentId}/runs/${req.params.runId}`
    );
    res.json(data);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, details: e.data });
  }
});

app.post("/api/chat/new", (_req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  const authNote =
    AUTH_USER && AUTH_PASSWORD ? " (basic auth enabled)" : " (no basic auth — set AUTH_USER and AUTH_PASSWORD in .env)";
  console.log(`Cursor Chat running at http://localhost:${PORT}${authNote}`);
});
