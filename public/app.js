const messagesEl = document.getElementById("messages");
const chatForm = document.getElementById("chatForm");
const promptInput = document.getElementById("promptInput");
const sendBtn = document.getElementById("sendBtn");
const modelSelect = document.getElementById("modelSelect");
const newChatBtn = document.getElementById("newChatBtn");
const statusBar = document.getElementById("statusBar");

const DEFAULT_MODEL_ID = "auto";

let agentId = sessionStorage.getItem("cursorAgentId") || null;
let agentModelId = sessionStorage.getItem("cursorAgentModelId");
if (agentModelId === "default") agentModelId = DEFAULT_MODEL_ID;
let isBusy = false;

function getSelectedModelId() {
  return modelSelect.value || DEFAULT_MODEL_ID;
}

function clearAgentSession() {
  agentId = null;
  agentModelId = null;
  sessionStorage.removeItem("cursorAgentId");
  sessionStorage.removeItem("cursorAgentModelId");
}

function normalizeModelId(id) {
  return id === "default" ? DEFAULT_MODEL_ID : id;
}

function syncAgentWithModel() {
  const selected = normalizeModelId(getSelectedModelId());
  const bound = normalizeModelId(agentModelId);
  if (agentId && bound && bound !== selected) {
    clearAgentSession();
    setStatus("Model changed — next message starts a new chat", "ok");
  }
}

if (typeof marked !== "undefined") {
  marked.setOptions({ breaks: true, gfm: true });
}

function renderMarkdown(el, text) {
  if (!text) {
    el.textContent = "";
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

function setStatus(text, type = "") {
  statusBar.textContent = text;
  statusBar.className = "status-bar" + (type ? ` ${type}` : "");
}

function clearWelcome() {
  const welcome = messagesEl.querySelector(".welcome");
  if (welcome) welcome.remove();
}

function appendMessage(role, text = "") {
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
    content.textContent = text;
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

async function loadModels() {
  try {
    const res = await fetch("/api/models");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to load models");
    let saved = localStorage.getItem("cursorModelId") || DEFAULT_MODEL_ID;
    if (saved === "default") saved = DEFAULT_MODEL_ID;
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

async function streamResponse(agentId, runId, contentEl) {
  const res = await fetch(`/api/chat/${agentId}/runs/${runId}/stream`);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err || "Stream failed");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = parseSSEChunk(buffer, (event, payload) => {
      if (event === "assistant" && payload.text) {
        fullText += payload.text;
        renderMarkdown(contentEl, fullText);
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
      if (event === "result" && payload.text) {
        fullText = payload.text;
        renderMarkdown(contentEl, fullText);
      }
      if (event === "error") {
        throw new Error(payload.message || "Stream error");
      }
    });
  }

  if (!fullText) {
    const poll = await fetch(`/api/chat/${agentId}/runs/${runId}`);
    const run = await poll.json();
    if (run.result) {
      renderMarkdown(contentEl, run.result);
    } else if (run.status && run.status !== "FINISHED") {
      contentEl.textContent = `(Run ${run.status.toLowerCase()} — check Cursor dashboard for full output)`;
    }
  }

  contentEl.classList.remove("streaming");
}

async function sendMessage(text) {
  if (isBusy) return;
  isBusy = true;
  sendBtn.disabled = true;

  appendMessage("user", text);
  const contentEl = appendMessage("assistant", "Thinking…");

  try {
    syncAgentWithModel();
    const modelId = getSelectedModelId();
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, agentId, modelId }),
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
    const modelLabel =
      modelSelect.selectedOptions[0]?.textContent || agentModelId || modelId;
    setStatus(`Ready · ${modelLabel}`, "ok");
    contentEl.textContent = "";

    await streamResponse(agentId, data.runId, contentEl);
  } catch (e) {
    contentEl.classList.remove("streaming");
    contentEl.textContent = "";
    showError(e.message || "Something went wrong");
  } finally {
    isBusy = false;
    sendBtn.disabled = false;
    promptInput.focus();
  }
}

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = promptInput.value.trim();
  if (!text) return;
  promptInput.value = "";
  promptInput.style.height = "auto";
  sendMessage(text);
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

newChatBtn.addEventListener("click", () => {
  clearAgentSession();
  messagesEl.innerHTML = `
    <div class="welcome">
      <h1>How can I help you today?</h1>
      <p>Powered by Cursor Cloud Agents API</p>
    </div>
  `;
  setStatus("New chat started", "ok");
  setTimeout(checkHealth, 500);
});

syncAgentWithModel();
loadModels().then(() => {
  syncAgentWithModel();
  if (agentId) {
    const label = modelSelect.selectedOptions[0]?.textContent || getSelectedModelId();
    setStatus(`Resuming chat · ${label}`, "ok");
  }
});
checkHealth();
