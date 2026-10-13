// База знаний: нормативные документы, из которых ассистент берёт ответы.
// Каждый документ один раз извлекается в текст и хранится в data/knowledge.
// В запрос к Claude документы уходят целиком (с цитированием) — контекст 1M токенов
// это позволяет, а кэширование делает повторные вопросы дешёвыми.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

let dir = "";
let docs = []; // { id, name, file, chars, addedAt, removed? }

const manifestPath = () => path.join(dir, "knowledge.json");

function init(dataDir) {
  dir = path.join(dataDir, "knowledge");
  fs.mkdirSync(dir, { recursive: true });
  try {
    docs = JSON.parse(fs.readFileSync(manifestPath(), "utf8"));
  } catch {
    docs = [];
  }
}

function save() {
  const tmp = manifestPath() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(docs, null, 1));
  fs.renameSync(tmp, manifestPath());
}

// Грубая оценка: для русского юридического текста ~3 символа на токен.
const estimateTokens = (chars) => Math.round(chars / 3);

function list() {
  return docs
    .filter((d) => !d.removed)
    .map((d) => ({ id: d.id, name: d.name, chars: d.chars, tokens: estimateTokens(d.chars), addedAt: d.addedAt }));
}

// Снимок базы для нового чата: чат всегда видит документы под теми же названиями,
// даже если базу потом поменяют (иначе ломается кэш и сохранённые размышления модели).
function snapshot() {
  return docs.filter((d) => !d.removed).map((d) => ({ id: d.id, title: d.name }));
}

// ---------- извлечение текста ----------

let pdfjs = null;

async function pdfToText(buf) {
  pdfjs ??= await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdf = await pdfjs.getDocument({
    data: new Uint8Array(buf),
    isEvalSupported: false,
    verbosity: 0, // шрифты для извлечения текста не нужны — не засоряем лог предупреждениями
  }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const content = await (await pdf.getPage(i)).getTextContent();
    let text = "";
    for (const item of content.items) {
      text += item.str;
      if (item.hasEOL) text += "\n";
    }
    // Номер страницы в тексте помогает ассистенту ссылаться на источник.
    pages.push(`[стр. ${i}]\n${text.trim()}`);
  }
  await pdf.destroy();
  return pages.join("\n\n");
}

async function docxToText(buf) {
  const mammoth = require("mammoth");
  const { value } = await mammoth.extractRawText({ buffer: buf });
  return value;
}

function htmlToText(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h\d|li|tr)>/gi, "\n")
    .replace(/<\/t[dh]>/gi, "\t")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&laquo;/g, "«")
    .replace(/&raquo;/g, "»")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// Текст из файла по его имени и содержимому. Используется и для базы знаний,
// и для вложений в сообщения (DOCX и HTML превращаются в текст).
async function extractText(fileName, buf) {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".pdf") return pdfToText(buf);
  if (ext === ".docx") return docxToText(buf);
  if (ext === ".doc") throw new Error("Старый формат .doc не поддерживается — пересохрани файл в .docx или PDF");
  if (buf.includes(0)) throw new Error("Формат не поддерживается (нужен PDF, DOCX, TXT или HTML)");
  const text = buf.toString("utf8");
  return ext === ".html" || ext === ".htm" ? htmlToText(text) : text;
}

function normalize(text) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// files: [{ name, buf }] — загруженные пользователем файлы.
async function add(files) {
  const added = [];
  const errors = [];
  for (const file of files) {
    const name = path.basename(file.name).replace(/\.[^.]+$/, "");
    try {
      const text = normalize(await extractText(file.name, file.buf));
      if (text.replace(/\[стр\. \d+\]/g, "").trim().length < 200) {
        throw new Error("В файле почти нет текста. Если это скан, сначала распознай его (OCR)");
      }
      const id = crypto.randomUUID();
      fs.writeFileSync(path.join(dir, id + ".txt"), text);
      const doc = { id, name, file: id + ".txt", chars: text.length, addedAt: Date.now() };
      docs.push(doc);
      added.push(doc);
    } catch (err) {
      errors.push(`${name}: ${err.message || err}`);
    }
  }
  save();
  return { added: added.length, errors };
}

// Удалённый документ скрывается из базы, но текст остаётся на диске:
// чаты, начатые с ним, продолжают видеть его без изменений.
function remove(id) {
  const doc = docs.find((d) => d.id === id);
  if (doc) {
    doc.removed = true;
    save();
  }
}

function rename(id, name) {
  const doc = docs.find((d) => d.id === id);
  if (doc && name.trim()) {
    doc.name = name.trim().slice(0, 200);
    save();
  }
}

// Документы для запроса: блоки document с включённым цитированием.
function blocks(entries) {
  const out = [];
  for (const { id, title } of entries) {
    const doc = docs.find((d) => d.id === id);
    if (!doc) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(dir, doc.file), "utf8");
    } catch {
      continue;
    }
    out.push({
      type: "document",
      title,
      source: { type: "text", media_type: "text/plain", data: text },
      citations: { enabled: true },
    });
  }
  return out;
}

module.exports = { init, list, snapshot, add, remove, rename, blocks, extractText, normalize };
