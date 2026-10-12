const { contextBridge, ipcRenderer, webUtils } = require("electron");

function on(channel, cb) {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("api", {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (patch) => ipcRenderer.invoke("settings:save", patch),

  listChats: () => ipcRenderer.invoke("chats:list"),
  getChat: (id) => ipcRenderer.invoke("chats:get", id),
  createChat: () => ipcRenderer.invoke("chats:create"),
  deleteChat: (id) => ipcRenderer.invoke("chats:delete", id),
  renameChat: (id, title) => ipcRenderer.invoke("chats:rename", id, title),

  pickFiles: () => ipcRenderer.invoke("files:pick"),
  readFiles: (files) =>
    ipcRenderer.invoke("files:read", files.map((f) => webUtils.getPathForFile(f))),

  send: (chatId, text, attachments) =>
    ipcRenderer.invoke("chat:send", { chatId, text, attachments }),
  stop: (chatId) => ipcRenderer.invoke("chat:stop", chatId),

  onDelta: (cb) => on("chat:delta", cb),
  onDone: (cb) => on("chat:done", cb),
  onError: (cb) => on("chat:error", cb),
  onFocusInput: (cb) => on("app:focus-input", cb),
  onNewChat: (cb) => on("app:new-chat", cb),
});
