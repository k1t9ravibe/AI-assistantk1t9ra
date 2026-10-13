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
  await updateChatKb(chat);
  renderMessages(chat.messages);
  if (chat.streaming && !state.streaming.has(id)) {
    appendNotice("Ассистент ещё дописывает ответ в этом чате — открой чат заново через минуту.");
  }
  updateComposerState();
  refreshChatList();
  $("input").focus();
}

// Чат видит тот состав базы, который был на момент первого сообщения.
async function updateChatKb(chat) {
  const el = $("chatKb");
  if (chat.kb && chat.messages.length) {
    el.textContent = chat.kb.length ? `📚 ${chat.kb.length} док.` : "📚 база пуста";
    el.title = chat.kb.length
      ? "Документы базы знаний в этом чате:\n" + chat.kb.map((d) => "• " + d.title).join("\n")
      : "Чат начат без документов в базе знаний";
  } else {
    const list = await window.api.listKnowledge();
    el.textContent = list.length ? `📚 ${list.length} док.` : "📚 база пуста";
    el.title = list.length ? "Документы базы знаний:\n" + list.map((d) => "• " + d.name).join("\n") : "Добавь нормативные документы: 📚 База знаний";
  }
  el.classList.toggle("warn", el.textContent.includes("пуста"));
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
  div.innerHTML = `<h1>Ассистент закупщика</h1><p>Спроси о процедуре или сроках закупки, попроси составить техспецификацию, письмо или ответ на жалобу. Документацию, заявки, договоры и КП для проверки перетащи в окно или прикрепи скрепкой.</p>`;
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
    body.innerHTML = assistantHtml(blocks);
    enhanceCode(body);
    div.appendChild(body);
    div.appendChild(copyButton(() => text));
  }
  return div;
}

// Ответ с цитатами: после процитированного фрагмента ставится сноска [n],
// а внизу — список источников с точным текстом нормы.
function assistantHtml(blocks) {
  const sources = [];
  let md = "";
  for (const b of blocks) {
    if (b.type !== "text") continue;
    md += b.text;
    if (!b.citations?.length) continue;
    const nums = [];
    for (const c of b.citations) {
      const key = `${c.document_index}|${c.cited_text}`;
      let i = sources.findIndex((x) => x.key === key);
      if (i < 0) i = sources.push({ key, title: c.document_title || "Документ", text: c.cited_text.trim(), page: c.start_page_number }) - 1;
      if (!nums.includes(i + 1)) nums.push(i + 1);
    }
    const tail = md.match(/\s*$/)[0];
    md = md.slice(0, md.length - tail.length) + nums.map((n) => `<sup class="cite" data-n="${n}">[${n}]</sup>`).join("") + tail;
  }
  let html = renderMarkdown(md);
  if (sources.length) {
    const items = sources
      .map((x, i) => `<li data-n="${i + 1}"><b>${escapeHtml(x.title)}</b>${x.page ? `, стр. ${x.page}` : ""}<div class="quote">«${escapeHtml(x.text)}»</div></li>`)
      .join("");
    html += `<details class="sources"><summary>Источники (${sources.length})</summary><ol>${items}</ol></details>`;
  }
  return html;
}

// Клик по сноске раскрывает список источников и подсвечивает нужный.
document.addEventListener("click", (e) => {
  const sup = e.target.closest?.("sup.cite");
  if (!sup) return;
  const details = sup.closest(".msg")?.querySelector("details.sources");
  const li = details?.querySelector(`li[data-n="${sup.dataset.n}"]`);
  if (!li) return;
  details.open = true;
  li.scrollIntoView({ block: "center", behavior: "smooth" });
  li.classList.remove("flash");
  void li.offsetWidth;
  li.classList.add("flash");
});

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
    if (summary && chatId === state.chatId) {
      $("chatTitle").textContent = summary.title;
      const chat = await window.api.getChat(chatId);
      if (chat) updateChatKb(chat);
    }
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

// ---------- settings ----------

async function openSettings(message = "") {
  const s = await window.api.getSettings();
  $("model").value = s.model;
  $("effort").value = s.effort;
  $("systemPrompt").value = s.systemPrompt;
  $("voiceLanguage").value = s.voiceLanguage;
  $("voiceModel").value = s.voiceModel;
  $("settingsError").textContent = message;
  $("settingsDialog").showModal();
}

$("settingsForm").addEventListener("submit", async (e) => {
  if (e.submitter?.value !== "default") return;
  e.preventDefault();
  const patch = {
    model: $("model").value,
    effort: $("effort").value,
    systemPrompt: $("systemPrompt").value,
    voiceLanguage: $("voiceLanguage").value,
    voiceModel: $("voiceModel").value,
  };
  try {
    await window.api.saveSettings(patch);
    $("settingsDialog").close();
  } catch (err) {
    $("settingsError").textContent = String(err.message || err);
  }
});

// ---------- knowledge base ----------

async function renderKnowledge() {
  const list = await window.api.listKnowledge();
  const ul = $("kbList");
  ul.innerHTML = "";
  if (!list.length) {
    ul.innerHTML = `<li class="kb-empty">База пуста — ассистент не сможет ссылаться на нормы.</li>`;
  }
  for (const d of list) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="title"></span><span class="size">≈${(d.tokens / 1000).toFixed(0)} тыс. токенов</span>
      <button class="icon small rename" title="Переименовать">✎</button>
      <button class="icon small del" title="Убрать из базы">✕</button>`;
    li.querySelector(".title").textContent = d.name;
    // Название — то, как ассистент будет ссылаться на документ в ответах.
    li.querySelector(".rename").onclick = () => {
      const span = li.querySelector(".title");
      const input = document.createElement("input");
      input.value = d.name;
      input.className = "rename-input";
      span.replaceWith(input);
      input.focus();
      input.select();
      const finish = async (save) => {
        input.onblur = null;
        if (save && input.value.trim()) await window.api.renameKnowledge(d.id, input.value);
        renderKnowledge();
      };
      input.onkeydown = (e) => {
        if (e.key === "Enter") finish(true);
        if (e.key === "Escape") { e.preventDefault(); finish(false); }
      };
      input.onblur = () => finish(true);
    };
    li.querySelector(".del").onclick = async () => {
      if (!confirm(`Убрать «${d.name}» из базы знаний?`)) return;
      await window.api.removeKnowledge(d.id);
      renderKnowledge();
    };
    ul.appendChild(li);
  }
  const total = list.reduce((sum, d) => sum + d.tokens, 0);
  $("kbTotal").textContent = list.length
    ? `Всего ≈${(total / 1000).toFixed(0)} тыс. токенов из ~1 000 тыс. доступных модели. ` +
      (total > 700000 ? "⚠ База близка к пределу: на переписку и вложения останется мало места. " : "") +
      "Изменения применяются к новым чатам."
    : "";
}

async function addKnowledge(files) {
  $("kbError").textContent = "Добавляю…";
  $("kbAddBtn").disabled = true;
  try {
    const { errors } = await window.api.addKnowledge(files);
    $("kbError").textContent = errors.join("\n");
  } catch (err) {
    $("kbError").textContent = String(err.message || err);
  } finally {
    $("kbAddBtn").disabled = false;
    renderKnowledge();
  }
}

async function openKnowledge() {
  $("kbError").textContent = "";
  await renderKnowledge();
  $("knowledgeDialog").showModal();
}

$("kbAddBtn").onclick = () => addKnowledge(null);
$("kbCloseBtn").onclick = async () => {
  $("knowledgeDialog").close();
  const chat = state.chatId && (await window.api.getChat(state.chatId));
  if (chat) updateChatKb(chat);
};

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
  if (!files.length) return;
  // Пока открыта база знаний, перетащенные файлы добавляются в неё, а не в сообщение.
  if ($("knowledgeDialog").open) addKnowledge(files);
  else addAttachments(await window.api.readFiles(files));
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

// ---------- voice ----------

let voiceBusy = false;

function setVoiceStatus(text) {
  $("voiceStatus").textContent = text || "";
  $("voiceStatus").classList.toggle("hidden", !text);
}

async function toggleVoice() {
  if (voiceBusy || !window.voice) return;
  const mic = $("micBtn");
  if (!window.voice.isRecording()) {
    try {
      await window.voice.start();
      mic.classList.add("recording");
      setVoiceStatus("🔴 Говори… Нажми 🎤 или Ctrl+M ещё раз, чтобы закончить.");
      // Пока человек говорит, заранее подгружаем модель.
      const s = await window.api.getSettings();
      window.voice.preload(s.voiceModel).catch(() => {});
    } catch (err) {
      setVoiceStatus("Нет доступа к микрофону. Проверь: Параметры Windows → Конфиденциальность → Микрофон.");
      setTimeout(() => setVoiceStatus(""), 6000);
    }
    return;
  }

  mic.classList.remove("recording");
  voiceBusy = true;
  mic.disabled = true;
  try {
    const s = await window.api.getSettings();
    setVoiceStatus("Распознаю речь…");
    const text = await window.voice.stop({ model: s.voiceModel, language: s.voiceLanguage, onStatus: setVoiceStatus });
    if (text) {
      const input = $("input");
      input.value = input.value.trim() ? `${input.value.trimEnd()} ${text}` : text;
      autoGrow();
      input.focus();
      setVoiceStatus("");
    } else {
      setVoiceStatus("Ничего не расслышал — попробуй ещё раз.");
      setTimeout(() => setVoiceStatus(""), 3000);
    }
  } catch (err) {
    setVoiceStatus("Ошибка распознавания: " + (err.message || err));
  } finally {
    voiceBusy = false;
    mic.disabled = false;
  }
}

// ---------- wiring ----------

$("newChatBtn").onclick = newChat;
$("settingsBtn").onclick = () => openSettings();
$("logoutBtn").onclick = async () => {
  await window.api.logout();
  location.href = "/login.html";
};
$("knowledgeBtn").onclick = openKnowledge;
$("chatKb").onclick = openKnowledge;
$("attachBtn").onclick = async () => addAttachments(await window.api.pickFiles());
$("micBtn").onclick = toggleVoice;
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
  if (e.altKey && e.code === "KeyN") { e.preventDefault(); newChat(); }
  if (e.ctrlKey && e.code === "KeyM") { e.preventDefault(); toggleVoice(); }
});

(async function init() {
  const settings = await window.api.getSettings();
  $("logoutBtn").classList.toggle("hidden", !settings.hasPassword);
  const list = await window.api.listChats();
  const firstEmpty = list.length ? null : await window.api.createChat();
  await openChat(firstEmpty ? firstEmpty.id : list[0].id);
  if (!settings.hasApiKey) appendNotice("На сервере не задан ANTHROPIC_API_KEY — впиши ключ в файл .env и перезапусти сервер.", "error");
})();
