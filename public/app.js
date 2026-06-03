const messagesEl = document.getElementById("messages");
const chatForm = document.getElementById("chatForm");
const promptInput = document.getElementById("promptInput");
const sendBtn = document.getElementById("sendBtn");
const attachBtn = document.getElementById("attachBtn");
const imageInput = document.getElementById("imageInput");
const attachPreview = document.getElementById("attachPreview");
const modelSelect = document.getElementById("modelSelect");
const newChatBtn = document.getElementById("newChatBtn");
const statusBar = document.getElementById("statusBar");

const DEFAULT_MODEL_ID = "composer-2.5";
const MAX_IMAGES = 5;
const MAX_IMAGE_DIMENSION = 2048;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const ARTIFACT_POLL_MS = 1500;
const ARTIFACT_POLL_MAX = 10;

const fastModeToggle = document.getElementById("fastModeToggle");

let agentId = sessionStorage.getItem("cursorAgentId") || null;
let agentModelId = sessionStorage.getItem("cursorAgentModelId");
if (agentModelId === "default") agentModelId = DEFAULT_MODEL_ID;
let isBusy = false;
let pendingImages = [];

function isFastMode() {
  return fastModeToggle?.checked !== false;
}

function getSelectedModelId() {
  if (isFastMode() && !pendingImages.length) {
    return "composer-2.5";
  }
  return modelSelect.value || DEFAULT_MODEL_ID;
}

function clearAgentSession() {
  agentId = null;
  agentModelId = null;
  sessionStorage.removeItem("cursorAgentId");
  sessionStorage.removeItem("cursorAgentModelId");
  sessionStorage.removeItem("cursorAgentProfile");
}

function normalizeModelId(id) {
  return id === "default" ? DEFAULT_MODEL_ID : id;
}

function effectiveModelKey() {
  return `${isFastMode() ? "fast" : "full"}:${normalizeModelId(getSelectedModelId())}`;
}

function syncAgentWithModel() {
  const selected = effectiveModelKey();
  const bound = sessionStorage.getItem("cursorAgentProfile");
  if (agentId && bound && bound !== selected) {
    clearAgentSession();
    setStatus("Settings changed — next message starts a new chat", "ok");
  }
}

if (typeof marked !== "undefined") {
  marked.setOptions({ breaks: true, gfm: true });
}

function renderMarkdown(el, text) {
  if (!text) {
    el.innerHTML = "";
    return;
  }
  if (typeof marked === "undefined" || typeof DOMPurify === "undefined") {
    el.textContent = text;
    return;
  }
  const raw = marked.parse(text, { async: false });
  el.innerHTML = DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true },
  });
}

/** Smooth typewriter reveal while tokens arrive (ChatGPT-style). */
class MessageStreamer {
  constructor(contentEl) {
    this.contentEl = contentEl;
    this.targetText = "";
    this.shownText = "";
    this.rafId = null;
    this.streamEnded = false;
    this.resolveDone = null;
    this.donePromise = new Promise((r) => {
      this.resolveDone = r;
    });
  }

  push(chunk) {
    if (!chunk) return;
    this.targetText += chunk;
    this.scheduleTick();
  }

  setFinal(text) {
    if (text) this.targetText = text;
    this.streamEnded = true;
    this.scheduleTick();
  }

  scheduleTick() {
    if (this.rafId != null) return;
    this.rafId = requestAnimationFrame(() => this.tick());
  }

  tick() {
    this.rafId = null;
    const behind = this.targetText.length - this.shownText.length;

    if (behind > 0) {
      const step = Math.min(behind, Math.max(2, Math.ceil(behind / 10) + 1));
      this.shownText = this.targetText.slice(0, this.shownText.length + step);
      this.renderPlain();
      messagesEl.scrollTop = messagesEl.scrollHeight;
      this.scheduleTick();
      return;
    }

    if (this.streamEnded) {
      this.finish();
      return;
    }
  }

  renderPlain() {
    this.contentEl.textContent = this.shownText;
  }

  finish() {
    if (this.rafId != null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.shownText = this.targetText;
    renderMarkdown(this.contentEl, this.targetText);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    if (this.resolveDone) {
      this.resolveDone();
      this.resolveDone = null;
    }
  }

  async waitUntilDone() {
    this.streamEnded = true;
    this.scheduleTick();
    await this.donePromise;
  }
}

function appendImagesToContent(contentEl, imageUrls, label) {
  if (!imageUrls?.length) return;
  const wrap = document.createElement("div");
  wrap.className = "message-images";
  if (label) {
    const cap = document.createElement("div");
    cap.className = "message-images-label";
    cap.textContent = label;
    wrap.appendChild(cap);
  }
  for (const src of imageUrls) {
    const img = document.createElement("img");
    img.src = src;
    img.alt = "Attached image";
    img.loading = "lazy";
    img.className = "chat-image";
    wrap.appendChild(img);
  }
  contentEl.appendChild(wrap);
}

function appendMessage(role, text = "", imagePreviewUrls = []) {
  clearWelcome();
  const div = document.createElement("div");
  div.className = `message ${role}`;
  div.innerHTML = `
    <div class="role">${role === "user" ? "You" : "AI"}</div>
    <div class="content${role === "assistant" ? " streaming" : ""}"></div>
  `;
  const content = div.querySelector(".content");
  if (role === "assistant") {
    renderMarkdown(content, text);
  } else {
    if (text) {
      const p = document.createElement("p");
      p.className = "user-text";
      p.textContent = text;
      content.appendChild(p);
    }
    appendImagesToContent(content, imagePreviewUrls);
  }
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return content;
}

function showError(message) {
  clearWelcome();
  const div = document.createElement("div");
  div.className = "error-toast";
  div.textContent = message;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function setStatus(text, type = "") {
  statusBar.textContent = text;
  statusBar.className = "status-bar" + (type ? ` ${type}` : "");
}

function clearWelcome() {
  const welcome = messagesEl.querySelector(".welcome");
  if (welcome) welcome.remove();
}

function renderAttachPreview() {
  attachPreview.innerHTML = "";
  if (!pendingImages.length) {
    attachPreview.hidden = true;
    return;
  }
  attachPreview.hidden = false;
  for (let i = 0; i < pendingImages.length; i++) {
    const item = pendingImages[i];
    const chip = document.createElement("div");
    chip.className = "attach-chip";
    chip.innerHTML = `
      <img src="${item.previewUrl}" alt="" />
      <button type="button" class="attach-remove" data-idx="${i}" aria-label="Remove">×</button>
    `;
    attachPreview.appendChild(chip);
  }
  attachPreview.querySelectorAll(".attach-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.idx);
      const removed = pendingImages.splice(idx, 1)[0];
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      renderAttachPreview();
    });
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function compressImage(file) {
  const dataUrl = await readFileAsDataUrl(file);
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = dataUrl;
  });

  let { width, height } = img;
  const scale = Math.min(
    1,
    MAX_IMAGE_DIMENSION / Math.max(width, height)
  );
  width = Math.round(width * scale);
  height = Math.round(height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, width, height);

  const mimeType =
    file.type === "image/png" ? "image/png" : "image/jpeg";
  let quality = 0.88;
  let blob = await new Promise((r) => canvas.toBlob(r, mimeType, quality));
  while (blob && blob.size > MAX_IMAGE_BYTES && quality > 0.45) {
    quality -= 0.1;
    blob = await new Promise((r) => canvas.toBlob(r, mimeType, quality));
  }
  if (!blob) throw new Error("Could not process image");

  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return {
    data: btoa(binary),
    mimeType: blob.type,
    previewUrl: URL.createObjectURL(blob),
    name: file.name,
  };
}

async function addImageFiles(fileList) {
  const files = [...fileList].filter((f) => f.type.startsWith("image/"));
  if (!files.length) return;
  const room = MAX_IMAGES - pendingImages.length;
  if (room <= 0) {
    showError(`Maximum ${MAX_IMAGES} images per message.`);
    return;
  }
  for (const file of files.slice(0, room)) {
    try {
      pendingImages.push(await compressImage(file));
    } catch {
      showError(`Could not load ${file.name}`);
    }
  }
  renderAttachPreview();
}

function clearPendingImages() {
  for (const img of pendingImages) {
    if (img.previewUrl) URL.revokeObjectURL(img.previewUrl);
  }
  pendingImages = [];
  renderAttachPreview();
}

async function loadModels() {
  try {
    const res = await fetch("/api/models");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to load models");
    let saved =
      localStorage.getItem("cursorModelId") ||
      (isFastMode() ? DEFAULT_MODEL_ID : "auto");
    if (saved === "default") saved = isFastMode() ? DEFAULT_MODEL_ID : "auto";
    modelSelect.innerHTML = "";
    for (const m of data.items || []) {
      const opt = document.createElement("option");
      opt.value = m.id === "default" ? DEFAULT_MODEL_ID : m.id;
      opt.textContent = m.displayName || m.id;
      modelSelect.appendChild(opt);
    }
    if ([...modelSelect.options].some((o) => o.value === saved)) {
      modelSelect.value = saved;
    } else {
      modelSelect.value = DEFAULT_MODEL_ID;
    }
  } catch (e) {
    console.warn("Models:", e);
    modelSelect.value = DEFAULT_MODEL_ID;
  }
}

modelSelect.addEventListener("change", () => {
  localStorage.setItem("cursorModelId", modelSelect.value);
  syncAgentWithModel();
});

fastModeToggle?.addEventListener("change", () => {
  localStorage.setItem("cursorFastMode", isFastMode() ? "1" : "0");
  syncAgentWithModel();
});

async function checkHealth() {
  try {
    const res = await fetch("/api/health");
    const data = await res.json();
    if (data.ok) {
      const name = data.me?.userEmail || data.me?.apiKeyName || "Connected";
      setStatus(`Ready · ${name}`, "ok");
    } else {
      setStatus(data.error || "API error", "err");
    }
  } catch (e) {
    setStatus("Server offline", "err");
  }
}

function parseSSEChunk(buffer, onEvent) {
  const parts = buffer.split("\n\n");
  const remainder = parts.pop() || "";
  for (const part of parts) {
    if (!part.trim()) continue;
    let event = "message";
    let data = "";
    for (const line of part.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (data) {
      try {
        onEvent(event, JSON.parse(data));
      } catch {
        onEvent(event, data);
      }
    }
  }
  return remainder;
}

async function loadOutputArtifacts(agentId, contentEl, seenPaths) {
  try {
    const res = await fetch(`/api/chat/${agentId}/artifacts`);
    const data = await res.json();
    if (!res.ok) return false;
    let added = false;
    for (const item of data.items || []) {
      if (!item.url || seenPaths.has(item.path)) continue;
      seenPaths.add(item.path);
      appendImagesToContent(contentEl, [item.url], "Updated image");
      added = true;
    }
    if (added) messagesEl.scrollTop = messagesEl.scrollHeight;
    return added;
  } catch {
    return false;
  }
}

async function pollArtifacts(agentId, contentEl) {
  const seenPaths = new Set();
  for (let i = 0; i < ARTIFACT_POLL_MAX; i++) {
    const added = await loadOutputArtifacts(agentId, contentEl, seenPaths);
    if (added && i > 2) return;
    setStatus(`Waiting for output images… (${i + 1}/${ARTIFACT_POLL_MAX})`, "ok");
    await new Promise((r) => setTimeout(r, ARTIFACT_POLL_MS));
  }
}

async function streamResponse(agentId, runId, contentEl, hadInputImages) {
  const res = await fetch(`/api/chat/${agentId}/runs/${runId}/stream`);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err || "Stream failed");
  }

  const streamer = new MessageStreamer(contentEl);
  contentEl.textContent = "";
  let useDeltaEvents = false;
  let gotStreamText = false;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const handleEvent = (event, payload) => {
    if (event === "interaction_update" && payload?.type === "text-delta" && payload.text) {
      useDeltaEvents = true;
      gotStreamText = true;
      streamer.push(payload.text);
      return;
    }
    if (event === "assistant" && payload?.text) {
      if (!useDeltaEvents) {
        gotStreamText = true;
        streamer.push(payload.text);
      }
      return;
    }
    if (event === "result" && payload?.text) {
      gotStreamText = true;
      streamer.setFinal(payload.text);
      return;
    }
    if (event === "error") {
      throw new Error(payload.message || "Stream error");
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = parseSSEChunk(buffer, handleEvent);
  }

  if (!gotStreamText) {
    const poll = await fetch(`/api/chat/${agentId}/runs/${runId}`);
    const run = await poll.json();
    if (run.result) {
      streamer.setFinal(run.result);
    } else if (run.status && run.status !== "FINISHED") {
      contentEl.textContent = `(Run ${run.status.toLowerCase()} — check Cursor dashboard for full output)`;
      contentEl.classList.remove("streaming");
      return;
    }
  }

  streamer.streamEnded = true;
  streamer.scheduleTick();
  await streamer.waitUntilDone();

  contentEl.classList.remove("streaming");
  if (hadInputImages) {
    loadOutputArtifacts(agentId, contentEl, new Set());
    pollArtifacts(agentId, contentEl);
  }
}

async function sendMessage(text, images) {
  if (isBusy) return;
  isBusy = true;
  sendBtn.disabled = true;
  attachBtn.disabled = true;

  const previewUrls = images.map((img) => img.previewUrl);
  appendMessage("user", text, previewUrls);
  const contentEl = appendMessage("assistant", "");

  try {
    const totalBytes = images.reduce((n, img) => n + (img.data?.length || 0) * 0.75, 0);
    if (totalBytes > 4 * 1024 * 1024) {
      throw new Error("Images are too large. Remove one or use smaller files.");
    }
    syncAgentWithModel();
    const modelId = getSelectedModelId();
    const payload = {
      message: text,
      agentId,
      modelId: isFastMode() && !images.length ? "composer-2.5" : modelId,
      fastMode: isFastMode(),
      images: images.map(({ data, mimeType }) => ({ data, mimeType })),
    };
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || data.details?.message || "Request failed");
    }

    agentId = data.agentId;
    if (!data.reusedAgent) {
      agentModelId = data.modelId || modelId;
    }
    sessionStorage.setItem("cursorAgentId", agentId);
    sessionStorage.setItem("cursorAgentModelId", agentModelId || modelId);
    sessionStorage.setItem("cursorAgentProfile", effectiveModelKey());
    const modelLabel = data.modelLabel || agentModelId || modelId;
    setStatus(`Running · ${modelLabel}`, "ok");

    await streamResponse(agentId, data.runId, contentEl, images.length > 0);
    setStatus(`Ready · ${modelLabel}`, "ok");
  } catch (e) {
    contentEl.classList.remove("streaming");
    contentEl.textContent = "";
    showError(e.message || "Something went wrong");
  } finally {
    isBusy = false;
    sendBtn.disabled = false;
    attachBtn.disabled = false;
    promptInput.focus();
  }
}

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = promptInput.value.trim();
  if (!text && !pendingImages.length) return;
  const images = pendingImages.slice();
  promptInput.value = "";
  promptInput.style.height = "auto";
  clearPendingImages();
  sendMessage(text, images);
});

attachBtn.addEventListener("click", () => imageInput.click());

imageInput.addEventListener("change", () => {
  if (imageInput.files?.length) addImageFiles(imageInput.files);
  imageInput.value = "";
});

promptInput.addEventListener("input", () => {
  promptInput.style.height = "auto";
  promptInput.style.height = Math.min(promptInput.scrollHeight, 160) + "px";
});

promptInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    chatForm.requestSubmit();
  }
});

promptInput.addEventListener("paste", (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  const imageFiles = [];
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      const f = item.getAsFile();
      if (f) imageFiles.push(f);
    }
  }
  if (imageFiles.length) {
    e.preventDefault();
    addImageFiles(imageFiles);
  }
});

newChatBtn.addEventListener("click", () => {
  clearAgentSession();
  clearPendingImages();
  messagesEl.innerHTML = `
    <div class="welcome">
      <h1>How can I help you today?</h1>
      <p>Attach images to analyze or edit them. Outputs appear below the reply.</p>
    </div>
  `;
  setStatus("New chat started", "ok");
  setTimeout(checkHealth, 500);
});

if (localStorage.getItem("cursorFastMode") === "0") {
  fastModeToggle.checked = false;
}

syncAgentWithModel();
loadModels().then(() => {
  syncAgentWithModel();
  if (agentId) {
    const label = modelSelect.selectedOptions[0]?.textContent || getSelectedModelId();
    setStatus(`Resuming chat · ${label}`, "ok");
  }
});
checkHealth();
