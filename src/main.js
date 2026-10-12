const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  globalShortcut,
  ipcMain,
  dialog,
  nativeImage,
  safeStorage,
  shell,
} = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const Anthropic = require("@anthropic-ai/sdk").default;

const DEFAULT_SETTINGS = {
  apiKeyEnc: "",
  model: "claude-opus-5-5",
  effort: "medium",
  hotkey: "Control+Shift+Space",
  autostart: false,
  voiceModel: "onnx-community/whisper-base",
  voiceLanguage: "russian",
  systemPrompt:
    "Ты — личный ИИ-ассистент пользователя на его компьютере. Отвечай по-русски, если пользователь не пишет на другом языке. Будь конкретным и полезным.",
};

const IMAGE_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const MAX_FILE_BYTES = 30 * 1024 * 1024;

let win = null;
let tray = null;
let isQuitting = false;
const activeStreams = new Map(); // chatId -> stream

// ---------- storage ----------

const dataDir = () => app.getPath("userData");
const settingsPath = () => path.join(dataDir(), "settings.json");
const chatsPath = () => path.join(dataDir(), "chats.json");

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

let settings = null;
let chats = null;

function loadSettings() {
  settings = { ...DEFAULT_SETTINGS, ...readJson(settingsPath(), {}) };
}

function saveSettings() {
  writeJson(settingsPath(), settings);
}

function loadChats() {
  chats = readJson(chatsPath(), []);
}

function saveChats() {
  writeJson(chatsPath(), chats);
}

function getApiKey() {
  if (!settings.apiKeyEnc) return "";
  try {
    return safeStorage.decryptString(Buffer.from(settings.apiKeyEnc, "base64"));
  } catch {
    return "";
  }
}

function setApiKey(key) {
  settings.apiKeyEnc = key
    ? safeStorage.encryptString(key).toString("base64")
    : "";
}

function publicSettings() {
  const { apiKeyEnc, ...rest } = settings;
  return {
    ...rest,
    hasApiKey: Boolean(apiKeyEnc) || Boolean(process.env.ANTHROPIC_API_KEY),
  };
}

function chatSummary(c) {
  return { id: c.id, title: c.title, updatedAt: c.updatedAt };
}

// ---------- window / tray / hotkey ----------

function createWindow() {
  win = new BrowserWindow({
    show: false,
    width: 1000,
    height: 720,
    minWidth: 640,
    minHeight: 480,
    title: "AI Assistant",
    backgroundColor: "#16171c",
    icon: path.join(__dirname, "renderer", "icon.png"),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));

  // Разрешаем только микрофон (голосовой ввод) и запись в буфер обмена.
  const allowed = new Set(["media", "clipboard-sanitized-write"]);
  win.webContents.session.setPermissionRequestHandler((_wc, perm, cb) => cb(allowed.has(perm)));

  // Закрытие окна прячет его в трей, выход — через меню трея.
  win.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });

  // Ссылки из ответов открываем во внешнем браузере.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (url !== win.webContents.getURL()) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    }
  });
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  win.webContents.send("app:focus-input");
}

function toggleWindow() {
  if (win.isVisible() && win.isFocused()) win.hide();
  else showWindow();
}

function createTray() {
  const icon = nativeImage.createFromPath(
    path.join(__dirname, "renderer", "icon.png"),
  );
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip("AI Assistant");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Открыть", click: showWindow },
      { label: "Новый чат", click: () => { showWindow(); win.webContents.send("app:new-chat"); } },
      { type: "separator" },
      { label: "Выход", click: () => { isQuitting = true; app.quit(); } },
    ]),
  );
  tray.on("click", toggleWindow);
}

function registerHotkey(accel) {
  globalShortcut.unregisterAll();
  if (!accel) return true;
  try {
    return globalShortcut.register(accel, toggleWindow);
  } catch {
    return false;
  }
}

// Автозапуск с Windows: при входе в систему приложение стартует свёрнутым в трей.
function applyAutostart() {
  const args = app.isPackaged ? ["--hidden"] : [app.getAppPath(), "--hidden"];
  app.setLoginItemSettings({ openAtLogin: settings.autostart, path: process.execPath, args });
}

// ---------- attachments ----------

function readAttachment(filePath) {
  const name = path.basename(filePath);
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_FILE_BYTES) {
    return { name, error: "Файл больше 30 МБ" };
  }
  const ext = path.extname(filePath).toLowerCase();
  const buf = fs.readFileSync(filePath);

  if (IMAGE_TYPES[ext]) {
    return { name, kind: "image", mediaType: IMAGE_TYPES[ext], data: buf.toString("base64") };
  }
  if (ext === ".pdf") {
    return { name, kind: "pdf", mediaType: "application/pdf", data: buf.toString("base64") };
  }
  // Всё остальное пробуем как текст.
  if (buf.includes(0)) {
    return { name, error: "Формат не поддерживается (нужен текст, PDF или картинка)" };
  }
  return { name, kind: "text", mediaType: "text/plain", data: buf.toString("utf8") };
}

function attachmentToBlock(a) {
  if (a.kind === "image") {
    return { type: "image", source: { type: "base64", media_type: a.mediaType, data: a.data } };
  }
  if (a.kind === "pdf") {
    return {
      type: "document",
      title: a.name,
      source: { type: "base64", media_type: "application/pdf", data: a.data },
    };
  }
  return {
    type: "document",
    title: a.name,
    source: { type: "text", media_type: "text/plain", data: a.data },
  };
}

// ---------- IPC ----------

function registerIpc() {
  ipcMain.handle("settings:get", () => publicSettings());

  ipcMain.handle("settings:save", (_e, patch) => {
    if (typeof patch.apiKey === "string") setApiKey(patch.apiKey.trim());
    for (const k of ["model", "effort", "systemPrompt", "voiceModel", "voiceLanguage"]) {
      if (typeof patch[k] === "string") settings[k] = patch[k];
    }
    if (typeof patch.autostart === "boolean") {
      settings.autostart = patch.autostart;
      applyAutostart();
    }
    let hotkeyOk = true;
    if (typeof patch.hotkey === "string" && patch.hotkey !== settings.hotkey) {
      hotkeyOk = registerHotkey(patch.hotkey);
      if (hotkeyOk) settings.hotkey = patch.hotkey;
      else registerHotkey(settings.hotkey);
    }
    saveSettings();
    return { settings: publicSettings(), hotkeyOk };
  });

  ipcMain.handle("chats:list", () =>
    chats.map(chatSummary).sort((a, b) => b.updatedAt - a.updatedAt),
  );

  ipcMain.handle("chats:get", (_e, id) => chats.find((c) => c.id === id) || null);

  ipcMain.handle("chats:create", () => {
    const now = Date.now();
    const chat = { id: crypto.randomUUID(), title: "Новый чат", createdAt: now, updatedAt: now, messages: [] };
    chats.push(chat);
    saveChats();
    return chat;
  });

  ipcMain.handle("chats:delete", (_e, id) => {
    activeStreams.get(id)?.abort();
    chats = chats.filter((c) => c.id !== id);
    saveChats();
    return true;
  });

  ipcMain.handle("chats:rename", (_e, id, title) => {
    const chat = chats.find((c) => c.id === id);
    if (chat && title.trim()) {
      chat.title = title.trim().slice(0, 80);
      saveChats();
    }
    return true;
  });

  ipcMain.handle("files:pick", async () => {
    const res = await dialog.showOpenDialog(win, {
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "Поддерживаемые", extensions: ["png", "jpg", "jpeg", "gif", "webp", "pdf", "txt", "md", "csv", "json", "js", "ts", "py", "html", "css", "xml", "log"] },
        { name: "Все файлы", extensions: ["*"] },
      ],
    });
    if (res.canceled) return [];
    return res.filePaths.map(readAttachment);
  });

  ipcMain.handle("files:read", (_e, paths) => paths.map(readAttachment));

  ipcMain.handle("chat:stop", (_e, chatId) => {
    activeStreams.get(chatId)?.abort();
    return true;
  });

  ipcMain.handle("chat:send", async (_e, { chatId, text, attachments }) => {
    const chat = chats.find((c) => c.id === chatId);
    if (!chat) throw new Error("Чат не найден");

    const content = (attachments || []).map(attachmentToBlock);
    if (text.trim()) content.push({ type: "text", text });
    if (!content.length) return null;

    if (chat.messages.length === 0) {
      chat.title = (text.trim() || attachments[0]?.name || "Новый чат").slice(0, 50);
    }
    chat.messages.push({ role: "user", content });
    chat.updatedAt = Date.now();
    saveChats();

    streamReply(chat);
    return chatSummary(chat);
  });
}

async function streamReply(chat) {
  const send = (channel, payload) => win?.webContents.send(channel, { chatId: chat.id, ...payload });
  const apiKey = getApiKey();
  const client = new Anthropic(apiKey ? { apiKey } : {});

  let stream;
  try {
    stream = client.beta.messages.stream({
      model: settings.model,
      max_tokens: 64000,
      thinking: { type: "adaptive" },
      output_config: { effort: settings.effort },
      system: settings.systemPrompt,
      messages: chat.messages,
      cache_control: { type: "ephemeral" },
      // Если модель откажется отвечать, запрос автоматически уйдёт на подходящую резервную модель.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    activeStreams.set(chat.id, stream);
    stream.on("text", (delta) => send("chat:delta", { delta }));

    const message = await stream.finalMessage();
    // Сохраняем ответ целиком (включая блоки размышлений) — история только дополняется.
    chat.messages.push({ role: "assistant", content: message.content });
    chat.updatedAt = Date.now();
    saveChats();

    let notice = null;
    if (message.stop_reason === "refusal") notice = "Модель отказалась отвечать на этот запрос.";
    else if (message.stop_reason === "max_tokens") notice = "Ответ обрезан: достигнут лимит длины.";
    send("chat:done", { message: { role: "assistant", content: message.content }, notice });
  } catch (err) {
    if (stream?.aborted || err instanceof Anthropic.APIUserAbortError) {
      // Сохраняем то, что успело прийти, чтобы разговор продолжался логично.
      const partial = stream?.currentMessage?.content?.filter((b) => b.type === "text" && b.text) || [];
      if (partial.length) {
        chat.messages.push({ role: "assistant", content: partial.map((b) => ({ type: "text", text: b.text })) });
        saveChats();
      }
      send("chat:done", { message: partial.length ? { role: "assistant", content: partial } : null, notice: "Остановлено." });
    } else {
      send("chat:error", { error: describeError(err) });
    }
  } finally {
    activeStreams.delete(chat.id);
  }
}

function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return "Неверный API-ключ. Проверь его в настройках.";
  if (err instanceof Anthropic.PermissionDeniedError) return "Нет доступа к этой модели для твоего ключа.";
  if (err instanceof Anthropic.RateLimitError) return "Слишком много запросов — подожди немного и попробуй снова.";
  if (err instanceof Anthropic.BadRequestError) return "Ошибка запроса: " + err.message;
  if (err instanceof Anthropic.APIConnectionError) return "Нет соединения с сервером Anthropic. Проверь интернет.";
  if (err instanceof Anthropic.APIError) return `Ошибка API ${err.status ?? ""}: ${err.message}`;
  if (/api key|apiKey|authentication/i.test(String(err?.message))) return "Не задан API-ключ. Открой настройки (⚙) и вставь ключ.";
  return String(err?.message || err);
}

// ---------- lifecycle ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);

  app.whenReady().then(() => {
    app.setAppUserModelId("com.k1t9ravibe.aiassistant");
    loadSettings();
    loadChats();
    registerIpc();
    createWindow();
    createTray();
    if (!process.argv.includes("--hidden")) win.once("ready-to-show", showWindow);
    applyAutostart();
    if (!registerHotkey(settings.hotkey)) {
      console.warn("Не удалось зарегистрировать горячую клавишу", settings.hotkey);
    }
  });

  app.on("before-quit", () => { isQuitting = true; });
  app.on("will-quit", () => globalShortcut.unregisterAll());
  app.on("window-all-closed", (e) => e.preventDefault());
}
