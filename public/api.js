// Мост между интерфейсом и сервером: те же методы window.api, что были в десктоп-версии,
// только поверх fetch. Ответ ассистента приходит потоком событий (text/event-stream).

(function () {
  const listeners = { delta: [], done: [], error: [], chat: [] };
  const on = (event) => (cb) => {
    listeners[event].push(cb);
    return () => listeners[event].splice(listeners[event].indexOf(cb) >>> 0, 1);
  };
  const fire = (event, payload) => listeners[event].forEach((cb) => cb(payload));

  async function request(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401) {
      location.href = "/login.html";
      throw new Error("Нужно войти");
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || `Ошибка сервера ${res.status}`);
    return data;
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(",")[1] || "");
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(file);
    });
  }

  async function encodeFiles(files) {
    return Promise.all([...files].map(async (f) => ({ name: f.name, data: await fileToBase64(f) })));
  }

  // Диалог выбора файлов через скрытый <input type=file>.
  function chooseFiles(accept) {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      if (accept) input.accept = accept;
      input.onchange = () => resolve([...input.files]);
      input.oncancel = () => resolve([]);
      input.click();
    });
  }

  // Разбор потока событий: блоки "event: x\ndata: {...}" через пустую строку.
  async function readEvents(res, chatId) {
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    let finished = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const event = raw.match(/^event: (.+)$/m)?.[1];
        const data = raw.match(/^data: (.+)$/m)?.[1];
        if (!event || !data) continue;
        const payload = { chatId, ...JSON.parse(data) };
        if (event === "done" || event === "error") finished = true;
        fire(event, payload);
      }
    }
    if (!finished) fire("error", { chatId, error: "Соединение с сервером прервалось. Обнови страницу — ответ мог сохраниться в чате." });
  }

  const ACCEPT_ATTACH = ".png,.jpg,.jpeg,.gif,.webp,.pdf,.docx,.txt,.md,.csv,.json,.xml,.html,.htm,.log";
  const ACCEPT_KB = ".pdf,.docx,.txt,.md,.html,.htm";

  window.api = {
    getSettings: () => request("GET", "/api/settings"),
    saveSettings: (patch) => request("PUT", "/api/settings", patch),
    logout: () => request("POST", "/api/logout"),

    listChats: () => request("GET", "/api/chats"),
    getChat: (id) => request("GET", `/api/chats/${id}`),
    createChat: () => request("POST", "/api/chats"),
    deleteChat: (id) => request("DELETE", `/api/chats/${id}`),
    renameChat: (id, title) => request("PATCH", `/api/chats/${id}`, { title }),

    pickFiles: async () => {
      const files = await chooseFiles(ACCEPT_ATTACH);
      return files.length ? window.api.readFiles(files) : [];
    },
    readFiles: async (files) => request("POST", "/api/files", { files: await encodeFiles(files) }),

    listKnowledge: () => request("GET", "/api/kb"),
    addKnowledge: async (files) => {
      files ??= await chooseFiles(ACCEPT_KB);
      if (!files.length) return { added: 0, errors: [] };
      return request("POST", "/api/kb", { files: await encodeFiles(files) });
    },
    removeKnowledge: (id) => request("DELETE", `/api/kb/${id}`),
    renameKnowledge: (id, name) => request("PATCH", `/api/kb/${id}`, { name }),

    // Возвращает сводку чата (с новым названием), как только сервер принял сообщение;
    // сам ответ приходит дальше через onDelta / onDone / onError.
    send: async (chatId, text, attachments) => {
      const res = await fetch(`/api/chats/${chatId}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, attachments }),
      });
      if (res.status === 401) {
        location.href = "/login.html";
        throw new Error("Нужно войти");
      }
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || `Ошибка сервера ${res.status}`);
      }
      return new Promise((resolve) => {
        const off = on("chat")((summary) => {
          if (summary.chatId !== chatId) return;
          off();
          resolve(summary);
        });
        readEvents(res, chatId).catch((err) => {
          off();
          resolve(null);
          fire("error", { chatId, error: String(err.message || err) });
        });
      });
    },
    stop: (chatId) => request("POST", `/api/chats/${chatId}/stop`),

    onDelta: on("delta"),
    onDone: on("done"),
    onError: on("error"),
    onFocusInput: () => () => {},
    onNewChat: () => () => {},
  };
})();
