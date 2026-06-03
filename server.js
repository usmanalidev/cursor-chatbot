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
const DEFAULT_MODEL_ID = process.env.CURSOR_DEFAULT_MODEL || "composer-2.5";
const FAST_MODE_DEFAULT = process.env.CURSOR_FAST_MODE !== "0";
const AGENT_BUSY_WAIT_MS = Number(process.env.AGENT_BUSY_WAIT_MS) || 90000;
const AGENT_BUSY_POLL_MS = Number(process.env.AGENT_BUSY_POLL_MS) || 500;
const AGENT_WAIT_MS = Number(process.env.AGENT_WAIT_MS) || 300000;
const MAX_IMAGES = 5;
const IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

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

function resolveModel(modelId, { hasImages = false, fastMode = FAST_MODE_DEFAULT } = {}) {
  let id = (modelId || DEFAULT_MODEL_ID).trim();
  if (id === "default") id = "auto";

  const useFastComposer =
    fastMode &&
    !hasImages &&
    (!modelId || id === "auto" || id === "composer-2.5" || id === "composer-2-5");

  if (useFastComposer) {
    return {
      id: "composer-2.5",
      params: [{ id: "fast", value: "true" }],
    };
  }

  if (id === "auto") return { id: "auto" };
  return { id };
}

function modelDisplayName(model) {
  if (!model) return "unknown";
  const fast = model.params?.some(
    (p) => p.id === "fast" && String(p.value) === "true"
  );
  if (model.id === "composer-2.5" && fast) return "Composer 2.5 (Fast)";
  if (model.id === "auto") return "Auto";
  return model.id;
}

if (!API_KEY && !process.env.VERCEL) {
  console.error("Missing CURSOR_API_KEY in .env");
  process.exit(1);
}

const app = express();
app.use(requireBasicAuth);
app.use(express.json({ limit: "25mb" }));
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

function normalizeImages(images) {
  if (!Array.isArray(images)) return [];
  const out = [];
  for (const img of images.slice(0, MAX_IMAGES)) {
    if (!img?.data || !img?.mimeType) continue;
    const mimeType = String(img.mimeType).toLowerCase();
    if (!IMAGE_MIME_TYPES.has(mimeType)) continue;
    const data = String(img.data).replace(/\s/g, "");
    if (!data) continue;
    out.push({ data, mimeType });
  }
  return out;
}

function buildPromptText(message, images, isNewAgent, fastMode) {
  const trimmed = String(message || "").trim();
  if (images.length) {
    const imageNote =
      " The user attached image(s). Analyze or edit them. Save modified images to artifacts/ (e.g. artifacts/edited.png).";
    if (isNewAgent) {
      return `You are a helpful assistant.${imageNote}\n\nUser: ${trimmed || "(see attached image(s))"}`;
    }
    return trimmed || "Please work with the attached image(s).";
  }
  if (isNewAgent && fastMode) {
    return `Reply concisely in plain text only. Do not use tools, terminals, or file access.\n\nUser: ${trimmed}`;
  }
  if (isNewAgent) {
    return `You are a helpful assistant. Answer clearly. Avoid tools unless necessary.\n\nUser: ${trimmed}`;
  }
  return trimmed;
}

function buildPrompt(message, images, isNewAgent, fastMode) {
  const prompt = {
    text: buildPromptText(message, images, isNewAgent, fastMode),
  };
  if (images.length) {
    prompt.images = images;
  }
  return prompt;
}

async function waitForRunIdle(agentId, maxWaitMs = AGENT_BUSY_WAIT_MS) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const agent = await apiFetch(`${API_BASE}/v1/agents/${agentId}`);
    if (!agent.latestRunId) return;
    const run = await apiFetch(
      `${API_BASE}/v1/agents/${agentId}/runs/${agent.latestRunId}`
    );
    const busy = run.status === "CREATING" || run.status === "RUNNING";
    if (!busy) return;
    await new Promise((r) => setTimeout(r, AGENT_BUSY_POLL_MS));
  }
  throw new Error("Agent is still busy. Try again in a moment.");
}

app.get("/api/health", async (_req, res) => {
  try {
    const me = await apiFetch(`${API_BASE}/v1/me`);
    res.json({
      ok: true,
      me,
      config: {
        fastModeDefault: FAST_MODE_DEFAULT,
        defaultModelId: DEFAULT_MODEL_ID,
      },
    });
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
  const { message, agentId, modelId, images: rawImages, fastMode } = req.body || {};
  const images = normalizeImages(rawImages);
  const hasText = message && String(message).trim();
  const useFastMode = fastMode !== false && FAST_MODE_DEFAULT;
  if (!hasText && images.length === 0) {
    return res.status(400).json({ error: "message or image is required" });
  }

  try {
    let agent;
    let run;
    const reusedAgent = Boolean(agentId);
    const modelOpts = { hasImages: images.length > 0, fastMode: useFastMode };
    const model = resolveModel(modelId, modelOpts);

    if (agentId) {
      await waitForRunIdle(agentId);
      const data = await apiFetch(`${API_BASE}/v1/agents/${agentId}/runs`, {
        method: "POST",
        body: JSON.stringify({
          prompt: buildPrompt(message, images, false, useFastMode),
        }),
      });
      run = data.run;
      agent = { id: agentId };
    } else {
      const body = {
        prompt: buildPrompt(message, images, true, useFastMode),
        name: "Chat",
        model,
      };
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
      modelId: model.id,
      modelLabel: modelDisplayName(model),
      fastMode: useFastMode,
      reusedAgent,
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
  res.setHeader("X-Accel-Buffering", "no");
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

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

app.get("/api/chat/:agentId/artifacts", async (req, res) => {
  try {
    const data = await apiFetch(
      `${API_BASE}/v1/agents/${req.params.agentId}/artifacts`
    );
    const items = (data.items || []).filter((item) =>
      IMAGE_EXT.test(item.path || "")
    );
    const withUrls = [];
    for (const item of items) {
      try {
        const dl = await apiFetch(
          `${API_BASE}/v1/agents/${req.params.agentId}/artifacts/download?path=${encodeURIComponent(item.path)}`
        );
        withUrls.push({
          ...item,
          url: `/api/chat/${req.params.agentId}/artifact?path=${encodeURIComponent(item.path)}`,
          expiresAt: dl.expiresAt,
        });
      } catch {
        withUrls.push(item);
      }
    }
    res.json({ items: withUrls });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, details: e.data });
  }
});

app.get("/api/chat/:agentId/artifact", async (req, res) => {
  const filePath = req.query.path;
  if (!filePath || !String(filePath).startsWith("artifacts/")) {
    return res.status(400).json({ error: "Invalid artifact path" });
  }
  try {
    const dl = await apiFetch(
      `${API_BASE}/v1/agents/${req.params.agentId}/artifacts/download?path=${encodeURIComponent(filePath)}`
    );
    const upstream = await fetch(dl.url);
    if (!upstream.ok) {
      return res.status(upstream.status).send("Failed to fetch artifact");
    }
    const contentType = upstream.headers.get("content-type");
    if (contentType) res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "private, max-age=300");
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.send(buf);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, details: e.data });
  }
});

module.exports = app;

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    const authNote =
      AUTH_USER && AUTH_PASSWORD
        ? " (basic auth enabled)"
        : " (no basic auth — set AUTH_USER and AUTH_PASSWORD in .env)";
    console.log(`Cursor Chat running at http://localhost:${PORT}${authNote}`);
  });
}
