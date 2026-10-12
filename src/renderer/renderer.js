const $ = (id) => document.getElementById(id);

const state = {
  chatId: null,
  pendingAttachments: [],
  // chatId -> { text, el } для ответов, которые ещё стримятся
  streaming: new Map(),
};

marked.setOptions({ gfm: true, breaks: true });

function renderMarkdown(text) {
  return DOMPurify.sanitize(marked.parse(text || ""));
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// ---------- chat list ----------

async function refreshChatList() {
  const list = await window.api.listChats();
  const ul = $("chatList");
  ul.innerHTML = "";
  for (const c of list) {
    const li = document.createElement("li");
    li.className = c.id === state.chatId ? "active" : "";
    li.innerHTML = `<span class="title">${escapeHtml(c.title)}</span>
      <button class="icon small rename" title="Переименовать">✎</button>
      <button class="icon small del" title="Удалить">✕</button>`;
    li.querySelector(".title").onclick = () => openChat(c.id);
    li.querySelector(".rename").onclick = (e) => { e.stopPropagation(); startRename(li, c); };
    li.querySelector(".del").onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Удалить чат «${c.title}»?`)) return;
      await window.api.deleteChat(c.id);
      if (c.id === state.chatId) await newChat();
      else refreshChatList();
    };
    ul.appendChild(li);
  }
}

function startRename(li, c) {
  const span = li.querySelector(".title");
  const input = document.createElement("input");
  input.value = c.title;
  input.className = "rename-input";
  span.replaceWith(input);
  input.focus();
  input.select();
  const finish = async (save) => {
    if (save) await window.api.renameChat(c.id, input.value);
    if (save && c.id === state.chatId) $("chatTitle").textContent = input.value.trim() || c.title;
    refreshChatList();
  };
  input.onkeydown = (e) => {
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  };
  input.onblur = () => finish(true);
}

async function newChat() {
  const chat = await window.api.createChat();
  await openChat(chat.id);
}

async function openChat(id) {
  const chat = await window.api.getChat(id);
  if (!chat) return newChat();
  state.chatId = id;
  $("chatTitle").textContent = chat.title;
  renderMessages(chat.messages);
  updateComposerState();
  refreshChatList();
  $("input").focus();
}

// ---------- messages ----------

function renderMessages(messages) {
  const box = $("messages");
  box.innerHTML = "";
  if (!messages.length && !state.streaming.has(state.chatId)) {
    box.appendChild(emptyState());
    return;
  }
  for (const m of messages) box.appendChild(messageEl(m));
  const s = state.streaming.get(state.chatId);
  if (s) {
    s.el = streamingEl(s.text);
    box.appendChild(s.el);
  }
  scrollToBottom(true);
}

function emptyState() {
  const div = document.createElement("div");
  div.className = "empty";
  div.innerHTML = `<h1>Чем помочь?</h1><p>Задай вопрос, перетащи файл (PDF, картинку, текст) в окно или прикрепи его скрепкой.</p>`;
  return div;
}

function messageEl(m) {
  const div = document.createElement("div");
  div.className = `msg ${m.role}`;
  const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;

  if (m.role === "user") {
    const files = document.createElement("div");
    files.className = "msg-files";
    for (const b of blocks) {
      if (b.type === "image") {
        const img = document.createElement("img");
        img.src = `data:${b.source.media_type};base64,${b.source.data}`;
        files.appendChild(img);
      } else if (b.type === "document") {
        const chip = document.createElement("span");
        chip.className = "chip";
        chip.textContent = "📄 " + (b.title || "документ");
        files.appendChild(chip);
      }
    }
    if (files.childElementCount) div.appendChild(files);
    const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    if (text) {
      const body = document.createElement("div");
      body.className = "body plain";
      body.textContent = text;
      div.appendChild(body);
    }
  } else {
    const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
    const body = document.createElement("div");
    body.className = "body md";
    body.innerHTML = renderMarkdown(text);
    enhanceCode(body);
    div.appendChild(body);
    div.appendChild(copyButton(() => text));
  }
  return div;
}

function streamingEl(text) {
  const div = document.createElement("div");
  div.className = "msg assistant streaming";
  div.innerHTML = `<div class="body md"></div>`;
  fillStreaming(div, text);
  return div;
}

function fillStreaming(el, text) {
  const body = el.querySelector(".body");
  body.innerHTML = text ? renderMarkdown(text) : `<span class="typing"><i></i><i></i><i></i></span>`;
}

function enhanceCode(root) {
  root.querySelectorAll("pre").forEach((pre) => {
    const wrap = document.createElement("div");
    wrap.className = "code-wrap";
    pre.replaceWith(wrap);
    wrap.appendChild(pre);
    wrap.appendChild(copyButton(() => pre.innerText, "small"));
  });
}

function copyButton(getText, extra = "") {
  const btn = document.createElement("button");
  btn.className = `copy ${extra}`;
  btn.textContent = "Копировать";
  btn.onclick = async () => {
    await navigator.clipboard.writeText(getText());
    btn.textContent = "Скопировано";
    setTimeout(() => (btn.textContent = "Копировать"), 1200);
  };
  return btn;
}

function appendNotice(text, kind = "notice") {
  const div = document.createElement("div");
  div.className = `notice ${kind}`;
  div.textContent = text;
  $("messages").appendChild(div);
  scrollToBottom(true);
}

function scrollToBottom(force = false) {
  const box = $("messages");
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  if (force || nearBottom) box.scrollTop = box.scrollHeight;
}

// ---------- composer ----------

function updateComposerState() {
  const busy = state.streaming.has(state.chatId);
  $("sendBtn").classList.toggle("hidden", busy);
  $("stopBtn").classList.toggle("hidden", !busy);
}

function renderAttachments() {
  const box = $("attachments");
  box.innerHTML = "";
  state.pendingAttachments.forEach((a, i) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    if (a.kind === "image") {
      chip.innerHTML = `<img src="data:${a.mediaType};base64,${a.data}" />`;
    }
    chip.append((a.kind === "image" ? "" : "📄 ") + a.name);
    const x = document.createElement("button");
    x.className = "icon small";
    x.textContent = "✕";
    x.onclick = () => { state.pendingAttachments.splice(i, 1); renderAttachments(); };
    chip.appendChild(x);
    box.appendChild(chip);
  });
}

function addAttachments(list) {
  for (const a of list) {
    if (a.error) alert(`${a.name}: ${a.error}`);
    else state.pendingAttachments.push(a);
  }
  renderAttachments();
}

async function send() {
  const input = $("input");
  const text = input.value;
  const attachments = state.pendingAttachments;
  if (!text.trim() && !attachments.length) return;
  if (state.streaming.has(state.chatId)) return;

  const settings = await window.api.getSettings();
  if (!settings.hasApiKey) {
    openSettings("Сначала вставь API-ключ Anthropic.");
    return;
  }

  const chatId = state.chatId;
  input.value = "";
  autoGrow();
  state.pendingAttachments = [];
  renderAttachments();

  const box = $("messages");
  box.querySelector(".empty")?.remove();
  const userContent = attachments.map((a) =>
    a.kind === "image"
      ? { type: "image", source: { media_type: a.mediaType, data: a.data } }
      : { type: "document", title: a.name },
  );
  if (text.trim()) userContent.push({ type: "text", text });
  box.appendChild(messageEl({ role: "user", content: userContent }));

  const s = { text: "", el: streamingEl("") };
  state.streaming.set(chatId, s);
  box.appendChild(s.el);
  scrollToBottom(true);
  updateComposerState();

  try {
    const summary = await window.api.send(chatId, text, attachments);
    if (summary && chatId === state.chatId) $("chatTitle").textContent = summary.title;
    refreshChatList();
  } catch (err) {
    state.streaming.delete(chatId);
    s.el.remove();
    appendNotice(String(err.message || err), "error");
    updateComposerState();
  }
}

function autoGrow() {
  const t = $("input");
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, 220) + "px";
}

// ---------- stream events ----------

let renderQueued = false;
window.api.onDelta(({ chatId, delta }) => {
  const s = state.streaming.get(chatId);
  if (!s) return;
  s.text += delta;
  if (chatId !== state.chatId || renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const cur = state.streaming.get(state.chatId);
    if (cur?.el) {
      fillStreaming(cur.el, cur.text);
      scrollToBottom();
    }
  });
});

window.api.onDone(({ chatId, message, notice }) => {
  const s = state.streaming.get(chatId);
  state.streaming.delete(chatId);
  if (chatId === state.chatId) {
    if (s?.el) {
      if (message) s.el.replaceWith(messageEl(message));
      else s.el.remove();
    }
    if (notice) appendNotice(notice);
    scrollToBottom();
    updateComposerState();
  }
  refreshChatList();
});

window.api.onError(({ chatId, error }) => {
  const s = state.streaming.get(chatId);
  state.streaming.delete(chatId);
  if (chatId === state.chatId) {
    s?.el?.remove();
    appendNotice(error, "error");
    updateComposerState();
  }
});

window.api.onFocusInput(() => $("input").focus());
window.api.onNewChat(() => newChat());

// ---------- settings ----------

async function openSettings(message = "") {
  const s = await window.api.getSettings();
  $("apiKey").value = "";
  $("apiKeyState").textContent = s.hasApiKey ? "✓ Ключ сохранён" : "Ключ не задан";
  $("model").value = s.model;
  $("effort").value = s.effort;
  $("hotkey").value = s.hotkey;
  $("systemPrompt").value = s.systemPrompt;
  $("settingsError").textContent = message;
  $("settingsDialog").showModal();
}

$("settingsForm").addEventListener("submit", async (e) => {
  if (e.submitter?.value !== "default") return;
  e.preventDefault();
  const patch = {
    model: $("model").value,
    effort: $("effort").value,
    hotkey: $("hotkey").value,
    systemPrompt: $("systemPrompt").value,
  };
  if ($("apiKey").value.trim()) patch.apiKey = $("apiKey").value;
  const { hotkeyOk, settings } = await window.api.saveSettings(patch);
  if (!hotkeyOk) {
    $("settingsError").textContent = "Это сочетание занято другой программой — выбери другое.";
    $("hotkey").value = settings.hotkey;
    return;
  }
  updateHotkeyHint(settings.hotkey);
  $("settingsDialog").close();
});

function updateHotkeyHint(hotkey) {
  $("hotkeyHint").textContent = hotkey ? `${hotkey.replace("Control", "Ctrl")} — показать/скрыть` : "";
}

$("hotkey").addEventListener("keydown", (e) => {
  e.preventDefault();
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
  if (e.key === "Backspace" || e.key === "Delete") { $("hotkey").value = ""; return; }
  const mods = [];
  if (e.ctrlKey) mods.push("Control");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Super");
  if (!mods.length) return; // глобальная клавиша без модификатора мешала бы обычной печати
  let key = e.code;
  if (/^Key[A-Z]$/.test(key)) key = key.slice(3);
  else if (/^Digit\d$/.test(key)) key = key.slice(5);
  else if (/^F\d{1,2}$/.test(key) || key === "Space") key = key;
  else if (key.startsWith("Arrow")) key = key.slice(5);
  else key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  $("hotkey").value = [...mods, key].join("+");
});

// ---------- drag & drop ----------

let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  if (!e.dataTransfer?.types.includes("Files")) return;
  dragDepth++;
  $("dropOverlay").classList.remove("hidden");
});
window.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) { dragDepth = 0; $("dropOverlay").classList.add("hidden"); }
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $("dropOverlay").classList.add("hidden");
  const files = [...(e.dataTransfer?.files || [])];
  if (files.length) addAttachments(await window.api.readFiles(files));
});

// Вставка картинки из буфера обмена (Ctrl+V скриншота).
$("input").addEventListener("paste", async (e) => {
  const items = [...(e.clipboardData?.items || [])].filter((i) => i.type.startsWith("image/"));
  if (!items.length) return;
  e.preventDefault();
  for (const item of items) {
    const blob = item.getAsFile();
    const dataUrl = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
    const [, mediaType, data] = dataUrl.match(/^data:(.+?);base64,(.*)$/);
    addAttachments([{ name: "скриншот.png", kind: "image", mediaType, data }]);
  }
});

// ---------- wiring ----------

$("newChatBtn").onclick = newChat;
$("settingsBtn").onclick = () => openSettings();
$("attachBtn").onclick = async () => addAttachments(await window.api.pickFiles());
$("sendBtn").onclick = send;
$("stopBtn").onclick = () => window.api.stop(state.chatId);
$("input").addEventListener("input", autoGrow);
$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key.toLowerCase() === "n") { e.preventDefault(); newChat(); }
});

(async function init() {
  const settings = await window.api.getSettings();
  updateHotkeyHint(settings.hotkey);
  const list = await window.api.listChats();
  const firstEmpty = list.length ? null : await window.api.createChat();
  await openChat(firstEmpty ? firstEmpty.id : list[0].id);
  if (!settings.hasApiKey) openSettings("Добро пожаловать! Вставь API-ключ Anthropic, чтобы начать.");
})();
