// Сервер ассистента закупщика: отдаёт веб-интерфейс, хранит чаты и базу знаний,
// проксирует запросы к Claude. API-ключ живёт только здесь, браузер его не видит.

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const Anthropic = require("@anthropic-ai/sdk").default;
const knowledge = require("./knowledge");

const ROOT = path.join(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");
try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {
  // .env необязателен — переменные можно задать в окружении.
}

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const PASSWORD = process.env.APP_PASSWORD || "";
const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || "data");

// Базовая инструкция ассистента-закупщика. Указания из настроек дописываются к ней.
const BASE_PROMPT = fs.readFileSync(path.join(__dirname, "prompts", "procurement.md"), "utf8").trim();

const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];
const EFFORTS = ["low", "medium", "high", "max"];
const DEFAULT_SETTINGS = {
  model: "claude-opus-5-5",
  effort: "medium",
  systemPrompt: "",
  voiceModel: "onnx-community/whisper-base",
  voiceLanguage: "russian",
};

const IMAGE_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const MAX_FILE_BYTES = 30 * 1024 * 1024;

const client = new Anthropic();
const activeStreams = new Map(); // chatId -> stream

// ---------- storage ----------

const settingsPath = path.join(DATA_DIR, "settings.json");
const chatsPath = path.join(DATA_DIR, "chats.json");

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

fs.mkdirSync(DATA_DIR, { recursive: true });
const settings = { ...DEFAULT_SETTINGS, ...readJson(settingsPath, {}) };
let chats = readJson(chatsPath, []);
knowledge.init(DATA_DIR);

const saveSettings = () => writeJson(settingsPath, settings);
const saveChats = () => writeJson(chatsPath, chats);

function publicSettings() {
  return { ...settings, hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY), hasPassword: Boolean(PASSWORD) };
}

function buildSystem() {
  const extra = settings.systemPrompt.trim();
  return extra ? `${BASE_PROMPT}\n\n# Дополнительные указания пользователя\n\n${extra}` : BASE_PROMPT;
}

function chatSummary(c) {
  return { id: c.id, title: c.title, updatedAt: c.updatedAt };
}

// ---------- auth ----------
// Сайт личный: вход по одному паролю из APP_PASSWORD, сессия — подписанная cookie.

const secretPath = path.join(DATA_DIR, "secret.json");
let SECRET = readJson(secretPath, null);
if (!SECRET) {
  SECRET = crypto.randomBytes(32).toString("hex");
  writeJson(secretPath, SECRET);
}
const SESSION_DAYS = 30;

function sign(value) {
  return crypto.createHmac("sha256", SECRET).update(value).digest("base64url");
}

function makeSession() {
  const expires = String(Date.now() + SESSION_DAYS * 86400000);
  return `${expires}.${sign(expires)}`;
}

function validSession(token) {
  const [expires, mac] = String(token || "").split(".");
  if (!expires || !mac || Number(expires) < Date.now()) return false;
  const expected = Buffer.from(sign(expires));
  const given = Buffer.from(mac);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function readCookie(req, name) {
  const match = (req.headers.cookie || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : "";
}

function samePassword(given) {
  const a = crypto.createHash("sha256").update(String(given || "")).digest();
  const b = crypto.createHash("sha256").update(PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

// Защита от перебора пароля: не больше 10 неудачных попыток за 15 минут с одного адреса.
const loginAttempts = new Map();
function recentFailures(ip) {
  const now = Date.now();
  const list = (loginAttempts.get(ip) || []).filter((t) => now - t < 15 * 60000);
  loginAttempts.set(ip, list);
  return list;
}

function requireAuth(req, res, next) {
  if (!PASSWORD || validSession(readCookie(req, "session"))) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Нужно войти" });
  res.redirect("/login.html");
}

// ---------- attachments ----------

async function readAttachment({ name, data }) {
  name = String(name || "файл");
  const buf = Buffer.from(String(data || ""), "base64");
  if (buf.length > MAX_FILE_BYTES) return { name, error: "Файл больше 30 МБ" };
  const ext = path.extname(name).toLowerCase();

  if (IMAGE_TYPES[ext]) {
    return { name, kind: "image", mediaType: IMAGE_TYPES[ext], data: buf.toString("base64") };
  }
  if (ext === ".pdf") {
    return { name, kind: "pdf", mediaType: "application/pdf", data: buf.toString("base64") };
  }
  // DOCX, HTML и любой текст превращаем в текст.
  try {
    const text = knowledge.normalize(await knowledge.extractText(name, buf));
    return { name, kind: "text", mediaType: "text/plain", data: text };
  } catch (err) {
    return { name, error: err.message || String(err) };
  }
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
      citations: { enabled: true },
    };
  }
  return {
    type: "document",
    title: a.name,
    source: { type: "text", media_type: "text/plain", data: a.data },
    citations: { enabled: true },
  };
}

// ---------- Claude ----------

// Первое сообщение запроса — документы базы знаний. В истории чата оно не хранится,
// а собирается заново из снимка, поэтому байт-в-байт одинаково при каждом запросе.
function knowledgeMessage(kb) {
  const docs = knowledge.blocks(kb || []);
  const intro = docs.length
    ? `<knowledge_base>\nВыше — документы базы знаний проекта (${docs.length}):\n${docs.map((d, i) => `${i + 1}. ${d.title}`).join("\n")}\n</knowledge_base>`
    : "<knowledge_base>\nБаза знаний проекта пуста: нормативные документы не загружены.\n</knowledge_base>";
  return {
    role: "user",
    content: [...docs, { type: "text", text: intro, cache_control: { type: "ephemeral", ttl: "1h" } }],
  };
}

// Цитирование включается либо для всех документов запроса, либо ни для одного —
// поэтому старые вложения без citations тоже его получают.
function withCitations(messages) {
  return messages.map((m) =>
    m.role === "user" && Array.isArray(m.content) && m.content.some((b) => b.type === "document" && !b.citations)
      ? { ...m, content: m.content.map((b) => (b.type === "document" ? { ...b, citations: { enabled: true } } : b)) }
      : m,
  );
}

// Ответ генерируется до конца, даже если вкладку закрыли: он сохранится в чате.
async function streamReply(chat, emit) {
  let stream;
  try {
    // У Haiku нет серверного резервирования моделей.
    const fallback = !settings.model.startsWith("claude-haiku");
    stream = client.beta.messages.stream({
      model: settings.model,
      max_tokens: 64000,
      // drop_block: если история всё же изменилась (смена модели и т. п.),
      // устаревшие блоки размышлений отбрасываются вместо ошибки 400.
      thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
      output_config: { effort: settings.effort },
      system: chat.system,
      messages: [knowledgeMessage(chat.kb), ...withCitations(chat.messages)],
      cache_control: { type: "ephemeral" },
      betas: [
        "thinking-binding-controls-2026-08-01",
        // Если модель откажется отвечать, запрос автоматически уйдёт на подходящую резервную модель.
        ...(fallback ? ["server-side-fallback-2026-07-01"] : []),
      ],
      ...(fallback ? { fallbacks: "default" } : {}),
    });
    activeStreams.set(chat.id, stream);
    stream.on("text", (delta) => emit("delta", { delta }));

    const message = await stream.finalMessage();
    // Сохраняем ответ целиком (включая блоки размышлений) — история только дополняется.
    chat.messages.push({ role: "assistant", content: message.content });
    chat.updatedAt = Date.now();
    saveChats();

    let notice = null;
    if (message.stop_reason === "refusal") notice = "Модель отказалась отвечать на этот запрос.";
    else if (message.stop_reason === "max_tokens") notice = "Ответ обрезан: достигнут лимит длины.";
    emit("done", { message: { role: "assistant", content: message.content }, notice });
  } catch (err) {
    if (stream?.aborted || err instanceof Anthropic.APIUserAbortError) {
      // Сохраняем то, что успело прийти, чтобы разговор продолжался логично.
      const partial = stream?.currentMessage?.content?.filter((b) => b.type === "text" && b.text) || [];
      if (partial.length) {
        chat.messages.push({ role: "assistant", content: partial.map((b) => ({ type: "text", text: b.text })) });
        saveChats();
      }
      emit("done", { message: partial.length ? { role: "assistant", content: partial } : null, notice: "Остановлено." });
    } else {
      console.error(err);
      emit("error", { error: describeError(err) });
    }
  } finally {
    activeStreams.delete(chat.id);
  }
}

function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return "Неверный API-ключ. Проверь ANTHROPIC_API_KEY в файле .env на сервере.";
  if (err instanceof Anthropic.PermissionDeniedError) return "Нет доступа к этой модели для этого API-ключа.";
  if (err instanceof Anthropic.RateLimitError) return "Слишком много запросов — подожди немного и попробуй снова.";
  if (err instanceof Anthropic.BadRequestError && /prompt is too long|too many tokens/i.test(err.message)) {
    return "Документы базы знаний и переписка не помещаются в контекст модели. Начни новый чат или убери часть документов из базы.";
  }
  if (err instanceof Anthropic.BadRequestError) return "Ошибка запроса: " + err.message;
  if (err instanceof Anthropic.APIConnectionError) return "Сервер не может связаться с Anthropic. Проверь интернет на сервере.";
  if (err instanceof Anthropic.APIError) return `Ошибка API ${err.status ?? ""}: ${err.message}`;
  if (/api key|apiKey|authentication/i.test(String(err?.message))) return "На сервере не задан ANTHROPIC_API_KEY (файл .env).";
  return String(err?.message || err);
}

// ---------- routes ----------

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", "loopback"); // за nginx на этой же машине — берём реальный IP из X-Forwarded-For
app.use(express.json({ limit: "100mb" }));

app.post("/api/login", (req, res) => {
  const failures = recentFailures(req.ip);
  if (failures.length >= 10) return res.status(429).json({ error: "Слишком много попыток. Подожди 15 минут." });
  if (!PASSWORD || samePassword(req.body?.password)) {
    res.cookie("session", makeSession(), {
      httpOnly: true,
      sameSite: "strict",
      secure: req.secure,
      maxAge: SESSION_DAYS * 86400000,
    });
    return res.json({ ok: true });
  }
  failures.push(Date.now());
  res.status(401).json({ error: "Неверный пароль" });
});

app.post("/api/logout", (_req, res) => {
  res.clearCookie("session");
  res.json({ ok: true });
});

// Страница входа и её оформление доступны без пароля.
for (const file of ["login.html", "styles.css", "icon.png"]) {
  app.get(`/${file}`, (_req, res) => res.sendFile(path.join(PUBLIC, file)));
}
app.get("/favicon.ico", (_req, res) => res.sendFile(path.join(PUBLIC, "icon.ico")));

app.use(requireAuth);

// Браузерные библиотеки берём прямо из node_modules.
const vendor = {
  marked: "marked/lib",
  dompurify: "dompurify/dist",
  transformers: "@huggingface/transformers/dist",
  "onnxruntime-web": "onnxruntime-web/dist",
};
for (const [name, dir] of Object.entries(vendor)) {
  app.use(`/vendor/${name}`, express.static(path.join(ROOT, "node_modules", dir)));
}
app.use(express.static(PUBLIC));

app.get("/api/settings", (_req, res) => res.json(publicSettings()));

app.put("/api/settings", (req, res) => {
  const patch = req.body || {};
  if (MODELS.includes(patch.model)) settings.model = patch.model;
  if (EFFORTS.includes(patch.effort)) settings.effort = patch.effort;
  if (typeof patch.systemPrompt === "string") settings.systemPrompt = patch.systemPrompt.slice(0, 20000);
  for (const k of ["voiceModel", "voiceLanguage"]) {
    if (typeof patch[k] === "string") settings[k] = patch[k];
  }
  saveSettings();
  res.json({ settings: publicSettings() });
});

app.get("/api/chats", (_req, res) => {
  res.json(chats.map(chatSummary).sort((a, b) => b.updatedAt - a.updatedAt));
});

app.get("/api/chats/:id", (req, res) => {
  const chat = chats.find((c) => c.id === req.params.id);
  // Снимок системной инструкции браузеру не нужен.
  res.json(chat ? { ...chat, system: undefined, streaming: activeStreams.has(chat.id) } : null);
});

app.post("/api/chats", (_req, res) => {
  const now = Date.now();
  const chat = { id: crypto.randomUUID(), title: "Новый чат", createdAt: now, updatedAt: now, messages: [] };
  chats.push(chat);
  saveChats();
  res.json(chat);
});

app.delete("/api/chats/:id", (req, res) => {
  activeStreams.get(req.params.id)?.abort();
  chats = chats.filter((c) => c.id !== req.params.id);
  saveChats();
  res.json(true);
});

app.patch("/api/chats/:id", (req, res) => {
  const chat = chats.find((c) => c.id === req.params.id);
  const title = String(req.body?.title || "").trim();
  if (chat && title) {
    chat.title = title.slice(0, 80);
    saveChats();
  }
  res.json(true);
});

app.post("/api/files", async (req, res) => {
  const files = Array.isArray(req.body?.files) ? req.body.files : [];
  res.json(await Promise.all(files.map(readAttachment)));
});

app.get("/api/kb", (_req, res) => res.json(knowledge.list()));

app.post("/api/kb", async (req, res) => {
  const files = (Array.isArray(req.body?.files) ? req.body.files : []).map((f) => ({
    name: String(f.name || "документ"),
    buf: Buffer.from(String(f.data || ""), "base64"),
  }));
  res.json(await knowledge.add(files));
});

app.delete("/api/kb/:id", (req, res) => {
  knowledge.remove(req.params.id);
  res.json(true);
});

app.patch("/api/kb/:id", (req, res) => {
  knowledge.rename(req.params.id, String(req.body?.name || ""));
  res.json(true);
});

app.post("/api/chats/:id/stop", (req, res) => {
  activeStreams.get(req.params.id)?.abort();
  res.json(true);
});

// Отправка сообщения. Ответ приходит потоком событий (text/event-stream).
app.post("/api/chats/:id/send", (req, res) => {
  const chat = chats.find((c) => c.id === req.params.id);
  if (!chat) return res.status(404).json({ error: "Чат не найден" });
  if (activeStreams.has(chat.id)) return res.status(409).json({ error: "Ассистент ещё отвечает в этом чате" });

  const text = String(req.body?.text || "");
  const attachments = (Array.isArray(req.body?.attachments) ? req.body.attachments : []).filter(
    (a) => ["image", "pdf", "text"].includes(a?.kind) && typeof a.data === "string",
  );
  const content = attachments.map(attachmentToBlock);
  if (text.trim()) content.push({ type: "text", text });
  if (!content.length) return res.status(400).json({ error: "Пустое сообщение" });

  if (chat.messages.length === 0) {
    chat.title = (text.trim() || attachments[0]?.name || "Новый чат").slice(0, 50);
  }
  // Инструкция и состав базы фиксируются при первом сообщении и дальше не меняются:
  // так работает кэш, и модель не теряет свои прошлые размышления в этом чате.
  if (chat.messages.length === 0 || !chat.system) {
    chat.system = buildSystem();
    chat.kb = knowledge.snapshot();
  }
  chat.messages.push({ role: "user", content });
  chat.updatedAt = Date.now();
  saveChats();

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no", // nginx не должен копить поток
  });
  res.on("error", () => {}); // вкладку закрыли — ответ всё равно допишется в чат
  const write = (chunk) => {
    if (!res.writableEnded && !res.destroyed) res.write(chunk);
  };
  const emit = (event, payload) => write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  emit("chat", chatSummary(chat));
  // Пока модель думает, текст не идёт — пинг не даёт прокси оборвать соединение.
  const ping = setInterval(() => write(": ping\n\n"), 15000);
  streamReply(chat, emit).finally(() => {
    clearInterval(ping);
    if (!res.destroyed) res.end();
  });
});

app.listen(PORT, HOST, () => {
  console.log(`Ассистент закупщика: http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  if (!PASSWORD) console.warn("⚠ APP_PASSWORD не задан — сайт открыт без пароля. Не выставляй его в интернет в таком виде.");
  if (!process.env.ANTHROPIC_API_KEY) console.warn("⚠ ANTHROPIC_API_KEY не задан — ответы работать не будут.");
});
