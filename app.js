const els = {
  app: document.querySelector(".app"),
  body: document.body,
  fileInput: document.getElementById("fileInput"),
  openButton: document.getElementById("openButton"),
  welcomeOpen: document.getElementById("welcomeOpen"),
  dropZone: document.getElementById("dropZone"),
  readerViewport: document.getElementById("readerViewport"),
  readerContent: document.getElementById("readerContent"),
  bookTitle: document.getElementById("bookTitle"),
  bookFormat: document.getElementById("bookFormat"),
  bookStats: document.getElementById("bookStats"),
  progressBar: document.getElementById("progressBar"),
  progressText: document.getElementById("progressText"),
  chapterText: document.getElementById("chapterText"),
  savedText: document.getElementById("savedText"),
  tocPanel: document.getElementById("tocPanel"),
  marksPanel: document.getElementById("marksPanel"),
  tocTab: document.getElementById("tocTab"),
  marksTab: document.getElementById("marksTab"),
  sidebarToggle: document.getElementById("sidebarToggle"),
  fontSize: document.getElementById("fontSize"),
  measure: document.getElementById("measure"),
  bookmarkButton: document.getElementById("bookmarkButton"),
  searchInput: document.getElementById("searchInput"),
  searchNext: document.getElementById("searchNext"),
  toast: document.getElementById("toast"),
  authButton: document.getElementById("authButton"),
  authLabel: document.getElementById("authLabel"),
  authModal: document.getElementById("authModal"),
  authClose: document.getElementById("authClose"),
  authTitle: document.getElementById("authTitle"),
  authHint: document.getElementById("authHint"),
  authForm: document.getElementById("authForm"),
  authNameField: document.getElementById("authNameField"),
  authName: document.getElementById("authName"),
  authEmail: document.getElementById("authEmail"),
  authPassword: document.getElementById("authPassword"),
  authSubmit: document.getElementById("authSubmit"),
  authStatus: document.getElementById("authStatus"),
  authToggle: document.getElementById("authToggle"),
  authProfile: document.getElementById("authProfile"),
  authUserName: document.getElementById("authUserName"),
  authUserEmail: document.getElementById("authUserEmail"),
  syncNowButton: document.getElementById("syncNowButton"),
  logoutButton: document.getElementById("logoutButton"),
};

const storageKey = "litera-reader:v1";
const authStorageKey = "litera-reader:auth:v1";
const bookCacheDbName = "litera-reader-book-cache";
const bookCacheStoreName = "books";
const scriptSources = {
  jszip: "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js",
  pdfjs: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
  pdfWorker: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js",
};
let activeStoreKey = storageKey;
const defaultSettings = {
  theme: "day",
  fontSize: 20,
  measure: 740,
};

let state = {
  bookKey: "",
  title: "",
  format: "",
  toc: [],
  bookmarks: [],
  pdf: null,
  pdfObserver: null,
  pdfRenderToken: 0,
  renderedPdfPages: new Set(),
  authMode: "login",
  auth: null,
  saveTimer: null,
  syncTimer: null,
  toastTimer: null,
};

const wheelScrollSpeed = 2.6;
const scriptLoaders = new Map();

function loadScript(src, globalName, label) {
  if (window[globalName]) return Promise.resolve(window[globalName]);
  if (scriptLoaders.has(src)) return scriptLoaders.get(src);

  const loader = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.crossOrigin = "anonymous";
    script.onload = () => {
      if (window[globalName]) {
        resolve(window[globalName]);
      } else {
        reject(new Error(`${label} загрузилась некорректно. Обновите страницу и попробуйте снова.`));
      }
    };
    script.onerror = () => reject(new Error(`${label} не загрузилась. Проверьте интернет и попробуйте снова.`));
    document.head.append(script);
  }).catch((error) => {
    scriptLoaders.delete(src);
    throw error;
  });

  scriptLoaders.set(src, loader);
  return loader;
}

function loadJSZip() {
  return loadScript(scriptSources.jszip, "JSZip", "Библиотека EPUB");
}

async function loadPdfJs() {
  const pdfjs = await loadScript(scriptSources.pdfjs, "pdfjsLib", "Библиотека PDF");
  pdfjs.GlobalWorkerOptions.workerSrc = scriptSources.pdfWorker;
  return pdfjs;
}

function loadStore() {
  try {
    return JSON.parse(localStorage.getItem(activeStoreKey)) || {};
  } catch {
    return {};
  }
}

function saveStore(store) {
  localStorage.setItem(activeStoreKey, JSON.stringify(store));
}

function openBookCache() {
  if (!("indexedDB" in window)) return Promise.resolve(null);

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(bookCacheDbName, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(bookCacheStoreName)) {
        db.createObjectStore(bookCacheStoreName, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withBookCache(mode, callback) {
  const db = await openBookCache();
  if (!db) return null;

  return new Promise((resolve, reject) => {
    const tx = db.transaction(bookCacheStoreName, mode);
    const store = tx.objectStore(bookCacheStoreName);
    const result = callback(store);
    tx.oncomplete = () => {
      db.close();
      resolve(result);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

async function cacheBookFile(record) {
  const stored = {
    ...record,
    savedAt: Date.now(),
  };
  await withBookCache("readwrite", (store) => store.put(stored));
}

async function getCachedBookFile(bookKey) {
  return new Promise(async (resolve, reject) => {
    try {
      const db = await openBookCache();
      if (!db) return resolve(null);

      const tx = db.transaction(bookCacheStoreName, "readonly");
      const store = tx.objectStore(bookCacheStoreName);
      const request = store.get(bookKey);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => db.close();
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    } catch (error) {
      reject(error);
    }
  });
}

function rememberLastBook(meta) {
  const store = loadStore();
  store.lastBook = {
    key: meta.key,
    name: meta.name,
    title: meta.title,
    format: meta.format,
    savedAt: Date.now(),
  };
  saveStore(store);
}

function forgetLastBook() {
  const store = loadStore();
  delete store.lastBook;
  saveStore(store);
}

function getSettings() {
  const store = loadStore();
  return { ...defaultSettings, ...(store.settings || {}) };
}

function saveSettings(partial) {
  const store = loadStore();
  store.settings = { ...getSettings(), ...partial };
  store.settingsUpdatedAt = Date.now();
  saveStore(store);
  scheduleCloudSync();
}

function applySettings() {
  const settings = getSettings();
  els.body.dataset.theme = settings.theme;
  els.fontSize.value = settings.fontSize;
  els.measure.value = settings.measure;
  document.documentElement.style.setProperty("--reader-font-size", `${settings.fontSize}px`);
  document.documentElement.style.setProperty("--reader-measure", `${settings.measure}px`);

  document.querySelectorAll("[data-theme-choice]").forEach((button) => {
    button.classList.toggle("active", button.dataset.themeChoice === settings.theme);
  });
}

function showToast(message) {
  window.clearTimeout(state.toastTimer);
  els.toast.textContent = message;
  els.toast.classList.add("visible");
  state.toastTimer = window.setTimeout(() => els.toast.classList.remove("visible"), 2600);
}

function setActiveUserStore(userId) {
  activeStoreKey = userId ? `${storageKey}:user:${userId}` : storageKey;
}

function loadAuthSession() {
  try {
    return JSON.parse(localStorage.getItem(authStorageKey)) || null;
  } catch {
    return null;
  }
}

function saveAuthSession(auth) {
  localStorage.setItem(authStorageKey, JSON.stringify(auth));
}

function clearAuthSession() {
  localStorage.removeItem(authStorageKey);
}

async function apiRequest(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  if (state.auth?.token) headers.Authorization = `Bearer ${state.auth.token}`;

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), options.timeout || 18000);
  let response;
  try {
    response = await fetch(path, {
      method: options.method || "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Сервер долго не отвечает. Попробуйте еще раз.");
    }
    throw new Error("Нет соединения с сервером. Проверьте интернет и попробуйте снова.");
  } finally {
    window.clearTimeout(timeout);
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || "Ошибка сервера");
    error.status = response.status;
    throw error;
  }
  return payload;
}

function initAuth() {
  const saved = loadAuthSession();
  if (saved?.token && saved?.user?.id) {
    state.auth = saved;
    setActiveUserStore(saved.user.id);
  }
  updateAuthUi();
  if (state.auth) syncWithServer({ silent: true });
}

function openAuthModal() {
  if (!state.auth) setAuthStatus("");
  updateAuthUi();
  els.authModal.classList.remove("hidden");
  refreshIcons();
  window.setTimeout(() => {
    if (state.auth) els.syncNowButton.focus();
    else els.authEmail.focus();
  }, 0);
}

function closeAuthModal() {
  els.authModal.classList.add("hidden");
}

function setAuthMode(mode) {
  state.authMode = mode;
  setAuthStatus("");
  updateAuthUi();
}

function setAuthStatus(message, tone = "info") {
  if (!els.authStatus) return;
  els.authStatus.textContent = message;
  els.authStatus.dataset.tone = tone;
  els.authStatus.classList.toggle("visible", Boolean(message));
}

function setAuthBusy(isBusy, label) {
  els.authSubmit.disabled = isBusy;
  els.authSubmit.setAttribute("aria-busy", String(isBusy));
  els.authSubmit.classList.toggle("is-loading", isBusy);
  if (label) els.authSubmit.querySelector("span").textContent = label;
}

function restoreAuthSubmitLabel(mode = state.authMode) {
  els.authSubmit.querySelector("span").textContent = mode === "register" ? "Создать аккаунт" : "Войти";
  els.authSubmit.removeAttribute("aria-busy");
  els.authSubmit.classList.remove("is-loading");
}

function updateAuthUi() {
  const signedIn = Boolean(state.auth?.user);
  els.authButton.classList.toggle("signed-in", signedIn);
  els.authLabel.textContent = signedIn ? state.auth.user.name || state.auth.user.email : "Войти";

  els.authForm.classList.toggle("hidden", signedIn);
  els.authProfile.classList.toggle("hidden", !signedIn);
  els.syncNowButton.classList.toggle("hidden", !signedIn);
  els.logoutButton.classList.toggle("hidden", !signedIn);
  els.authToggle.classList.toggle("hidden", signedIn);

  if (signedIn) {
    els.authTitle.textContent = "Аккаунт";
    els.authHint.textContent = "Закладки, прогресс и настройки синхронизируются с этим аккаунтом.";
    els.authUserName.textContent = state.auth.user.name || "Аккаунт";
    els.authUserEmail.textContent = state.auth.user.email;
    return;
  }

  const isRegister = state.authMode === "register";
  els.authTitle.textContent = isRegister ? "Регистрация" : "Вход";
  els.authHint.textContent = isRegister
    ? "Создайте аккаунт, чтобы читать с разных устройств и не смешивать закладки."
    : "Войдите, чтобы хранить закладки и прогресс отдельно для вашего аккаунта.";
  els.authNameField.classList.toggle("hidden", !isRegister);
  els.authName.required = isRegister;
  els.authPassword.autocomplete = isRegister ? "new-password" : "current-password";
  els.authSubmit.querySelector("span").textContent = isRegister ? "Создать аккаунт" : "Войти";
  els.authToggle.textContent = isRegister ? "Уже есть аккаунт" : "Создать аккаунт";
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  const mode = state.authMode;
  const anonymousStore = activeStoreKey === storageKey ? loadStore() : {};
  const body = {
    email: els.authEmail.value.trim(),
    password: els.authPassword.value,
  };
  if (!body.email) {
    setAuthStatus("Введите email.", "error");
    els.authEmail.focus();
    return;
  }
  if (!els.authEmail.checkValidity()) {
    setAuthStatus("Проверьте формат email.", "error");
    els.authEmail.focus();
    return;
  }
  if (!body.password || body.password.length < 6) {
    setAuthStatus("Пароль должен быть не короче 6 символов.", "error");
    els.authPassword.focus();
    return;
  }
  if (mode === "register") body.name = els.authName.value.trim();

  setAuthStatus(mode === "register" ? "Создаем аккаунт..." : "Проверяем данные...", "info");
  setAuthBusy(true, mode === "register" ? "Создаем..." : "Входим...");
  try {
    const payload = await apiRequest(mode === "register" ? "/api/register" : "/api/login", {
      method: "POST",
      body,
    });
    handleAuthSuccess(payload, { migrateAnonymous: mode === "register", anonymousStore });
    await syncWithServer({ silent: true });
    closeAuthModal();
    showToast(mode === "register" ? "Аккаунт создан, синхронизация включена" : "Вы вошли, данные синхронизированы");
  } catch (error) {
    const message = error.message || "Не удалось войти";
    setAuthStatus(message, "error");
    showToast(message);
  } finally {
    els.authSubmit.disabled = false;
    restoreAuthSubmitLabel(mode);
  }
}

function handleAuthSuccess(payload, { migrateAnonymous = false, anonymousStore = {} } = {}) {
  state.auth = { token: payload.token, user: payload.user };
  saveAuthSession(state.auth);
  setActiveUserStore(payload.user.id);

  if (migrateAnonymous) {
    const userStore = loadStore();
    if (!Object.keys(userStore).length && Object.keys(anonymousStore || {}).length) {
      saveStore(anonymousStore);
    }
  }

  if (payload.data && !migrateAnonymous) applyRemoteData(payload.data, { restoreCurrentBook: true });
  updateAuthUi();
}

async function logout() {
  await flushPendingSaves();
  window.clearTimeout(state.syncTimer);
  try {
    if (state.auth) await apiRequest("/api/logout", { method: "POST" });
  } catch {
    // Local logout is still useful if the server is temporarily unavailable.
  }
  state.auth = null;
  clearAuthSession();
  setActiveUserStore(null);
  applySettings();
  updateAuthUi();
  closeAuthModal();
  showToast("Вы вышли из аккаунта");
}

function scheduleCloudSync() {
  if (!state.auth) return;
  window.clearTimeout(state.syncTimer);
  state.syncTimer = window.setTimeout(() => syncWithServer({ silent: true }), 1400);
}

async function syncWithServer({ silent = false } = {}) {
  if (!state.auth) return null;
  const payload = getSyncPayload();

  try {
    const response = await apiRequest("/api/sync", { method: "POST", body: payload });
    applyRemoteData(response.data, { restoreCurrentBook: true });
    if (!silent) showToast("Синхронизировано");
    return response.data;
  } catch (error) {
    if (error.status === 401) {
      state.auth = null;
      clearAuthSession();
      setActiveUserStore(null);
      updateAuthUi();
      showToast("Сессия истекла, войдите снова");
      return null;
    }
    if (!silent) showToast(error.message || "Синхронизация недоступна");
    return null;
  }
}

function getSyncPayload() {
  const store = loadStore();
  return {
    settings: store.settings || {},
    settingsUpdatedAt: Number(store.settingsUpdatedAt || 0),
    books: store.books || {},
  };
}

function applyRemoteData(remoteData, { restoreCurrentBook = false } = {}) {
  if (!remoteData) return;
  const store = mergeStoreData(loadStore(), remoteData);
  saveStore(store);
  applySettings();

  if (restoreCurrentBook && state.bookKey && store.books?.[state.bookKey]) {
    const saved = store.books[state.bookKey];
    state.bookmarks = saved.bookmarks || [];
    updateBookmarksPanel();

    if (typeof saved.progress === "number") {
      const maxScroll = Math.max(1, els.readerViewport.scrollHeight - els.readerViewport.clientHeight);
      const currentProgress = els.readerViewport.scrollTop / maxScroll;
      if (Math.abs(saved.progress - currentProgress) > 0.04) {
        jumpToProgress(saved.progress);
      }
    }
  }
}

function mergeStoreData(localData = {}, remoteData = {}) {
  const localSettingsUpdatedAt = Number(localData.settingsUpdatedAt || 0);
  const remoteSettingsUpdatedAt = Number(remoteData.settingsUpdatedAt || 0);
  const next = {
    ...localData,
    settings:
      remoteSettingsUpdatedAt > localSettingsUpdatedAt
        ? remoteData.settings || {}
        : localData.settings || remoteData.settings || {},
    settingsUpdatedAt: Math.max(localSettingsUpdatedAt, remoteSettingsUpdatedAt),
    books: { ...(remoteData.books || {}), ...(localData.books || {}) },
  };

  for (const [bookKey, remoteBook] of Object.entries(remoteData.books || {})) {
    const localBook = localData.books?.[bookKey];
    if (!localBook || Number(remoteBook.updatedAt || 0) > Number(localBook.updatedAt || 0)) {
      next.books[bookKey] = remoteBook;
    } else if (localBook && remoteBook) {
      next.books[bookKey] = mergeBookData(localBook, remoteBook);
    }
  }

  return next;
}

function mergeBookData(localBook, remoteBook) {
  const localUpdatedAt = Number(localBook.updatedAt || 0);
  const remoteUpdatedAt = Number(remoteBook.updatedAt || 0);
  if (localUpdatedAt > remoteUpdatedAt) return localBook;
  if (remoteUpdatedAt > localUpdatedAt) return remoteBook;

  const marks = new Map();

  [...(remoteBook.bookmarks || []), ...(localBook.bookmarks || [])].forEach((mark) => {
    if (!mark?.id) return;
    const current = marks.get(mark.id);
    if (!current || Number(mark.createdAt || 0) >= Number(current.createdAt || 0)) marks.set(mark.id, mark);
  });

  return {
    ...localBook,
    bookmarks: [...marks.values()].sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0)),
    updatedAt: localUpdatedAt,
  };
}

function setLoading(fileName) {
  els.readerContent.className = "reader-content";
  els.readerContent.innerHTML = `
    <div class="loading">
      <div>
        <strong>Открываю книгу</strong>
        <span>${escapeHtml(fileName)}</span>
      </div>
    </div>
  `;
  els.savedText.textContent = "Чтение файла...";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").trim();
}

function slugify(value, fallback) {
  const slug = normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[^a-zа-яё0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || fallback;
}

function fileExtension(file) {
  return file.name.split(".").pop().toLowerCase();
}

async function makeBookKey(file, buffer) {
  return `book:${await fingerprintBuffer(buffer)}:${file.size}`;
}

async function fingerprintBuffer(buffer) {
  if (window.crypto?.subtle) {
    try {
      const digest = await crypto.subtle.digest("SHA-256", buffer.slice(0));
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    } catch {
      // Fall back to a deterministic in-browser fingerprint below.
    }
  }

  const bytes = new Uint8Array(buffer);
  let hashA = 2166136261;
  let hashB = 16777619;
  for (let index = 0; index < bytes.length; index += 1) {
    hashA ^= bytes[index];
    hashA = Math.imul(hashA, 16777619);
    hashB ^= bytes[index] + index;
    hashB = Math.imul(hashB, 2246822519);
  }
  return `${(hashA >>> 0).toString(16).padStart(8, "0")}${(hashB >>> 0).toString(16).padStart(8, "0")}`;
}

async function handleFile(file) {
  if (!file) return;

  const ext = fileExtension(file);
  state.format = ext.toUpperCase();
  setLoading(file.name);

  try {
    const buffer = await file.arrayBuffer();
    state.bookKey = await makeBookKey(file, buffer);
    let cachedForRestore = false;
    try {
      await cacheBookFile({
        key: state.bookKey,
        name: file.name,
        size: file.size,
        type: file.type,
        ext,
        format: state.format,
        title: niceTitleFromFile(file.name),
        buffer: buffer.slice(0),
      });
      cachedForRestore = true;
    } catch (cacheError) {
      console.warn("Book cache is unavailable", cacheError);
      forgetLastBook();
    }

    let parsed;

    if (ext === "epub") {
      parsed = await parseEpub(buffer, file.name);
    } else if (ext === "pdf") {
      parsed = await parsePdf(buffer, file.name);
    } else {
      parsed = parseTextLike(buffer, file.name, ext);
    }

    state.title = parsed.title || niceTitleFromFile(file.name);
    if (cachedForRestore) {
      rememberLastBook({
        key: state.bookKey,
        name: file.name,
        title: state.title,
        format: state.format,
      });
    }
    renderBook(parsed.html, state.title, ext, parsed);
    restoreBookState();
    showToast("Книга открыта");
  } catch (error) {
    console.error(error);
    els.readerContent.className = "reader-content empty";
    els.readerContent.innerHTML = `
      <div class="welcome">
        <div class="cover-visual" aria-hidden="true">
          <div class="cover-spine"></div>
          <div class="cover-page"><span></span><span></span><span></span></div>
        </div>
        <p class="eyebrow">Не удалось открыть файл</p>
        <h2>${escapeHtml(error.message || "Формат не распознан")}</h2>
        <p>Попробуйте TXT, Markdown, EPUB или PDF. Для EPUB и PDF нужен доступ к CDN-библиотекам в браузере.</p>
      </div>
    `;
    els.savedText.textContent = "Ошибка открытия";
    showToast("Не удалось открыть книгу");
  }
}

async function restoreLastCachedBook() {
  const params = new URLSearchParams(window.location.search);
  if (params.has("demo") || state.bookKey) return false;

  const store = loadStore();
  const lastBook = store.lastBook;
  if (!lastBook?.key) return false;

  let cached;
  try {
    cached = await getCachedBookFile(lastBook.key);
  } catch (error) {
    console.warn("Could not read cached book", error);
    return false;
  }

  if (!cached?.buffer) return false;

  const ext = String(cached.ext || cached.name?.split(".").pop() || lastBook.format || "").toLowerCase();
  state.bookKey = cached.key;
  state.format = String(cached.format || ext).toUpperCase();
  setLoading(cached.name || lastBook.title || "Книга");

  try {
    const buffer = cached.buffer.slice ? cached.buffer.slice(0) : cached.buffer;
    let parsed;

    if (ext === "epub") {
      parsed = await parseEpub(buffer, cached.name || lastBook.title || "book.epub");
    } else if (ext === "pdf") {
      parsed = await parsePdf(buffer, cached.name || lastBook.title || "book.pdf");
    } else {
      parsed = parseTextLike(buffer, cached.name || lastBook.title || "book.txt", ext);
    }

    state.title = parsed.title || lastBook.title || niceTitleFromFile(cached.name || "book");
    renderBook(parsed.html, state.title, ext, parsed);
    restoreBookState();
    showToast("Книга восстановлена после обновления");
    return true;
  } catch (error) {
    console.error(error);
    showToast("Не удалось восстановить книгу из кэша");
    state.bookKey = "";
    return false;
  }
}

function decodeText(buffer) {
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  const badChars = (utf8.match(/\uFFFD/g) || []).length;
  if (badChars > Math.max(6, utf8.length * 0.006)) {
    try {
      return new TextDecoder("windows-1251", { fatal: false }).decode(buffer);
    } catch {
      return utf8;
    }
  }
  return utf8;
}

function parseTextLike(buffer, fileName, ext) {
  const raw = decodeText(buffer).replace(/\r\n?/g, "\n");
  const title = findTextTitle(raw) || niceTitleFromFile(fileName);
  const html = ext === "md" || ext === "markdown" ? markdownToHtml(raw, title) : plainTextToHtml(raw, title);
  return { title, html };
}

function findTextTitle(text) {
  const lines = text.split("\n").map(normalizeWhitespace).filter(Boolean).slice(0, 24);
  const heading = lines.find((line) => /^#\s+/.test(line));
  if (heading) return heading.replace(/^#\s+/, "");
  return lines.find((line) => line.length >= 3 && line.length <= 90) || "";
}

function niceTitleFromFile(fileName) {
  return fileName.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || "Без названия";
}

function markdownToHtml(markdown, title) {
  const lines = markdown.split("\n");
  const chunks = [];
  let paragraph = [];
  let list = [];
  let inCode = false;
  let code = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    chunks.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
    paragraph = [];
  };

  const flushList = () => {
    if (!list.length) return;
    chunks.push(`<ul>${list.map((item) => `<li>${inlineMarkdown(item)}</li>`).join("")}</ul>`);
    list = [];
  };

  const flushCode = () => {
    if (!code.length) return;
    chunks.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
    code = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        flushParagraph();
        flushList();
        inCode = true;
      }
      continue;
    }

    if (inCode) {
      code.push(line);
      continue;
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min(3, heading[1].length);
      chunks.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      flushParagraph();
      list.push(trimmed.replace(/^[-*]\s+/, ""));
      continue;
    }

    if (/^>\s+/.test(trimmed)) {
      flushParagraph();
      flushList();
      chunks.push(`<blockquote><p>${inlineMarkdown(trimmed.replace(/^>\s+/, ""))}</p></blockquote>`);
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    paragraph.push(trimmed);
  }

  flushParagraph();
  flushList();
  flushCode();

  if (!chunks.some((chunk) => /^<h1/.test(chunk))) {
    chunks.unshift(`<h1>${escapeHtml(title)}</h1>`);
  }

  return chunks.join("\n");
}

function inlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`(.+?)`/g, "<code>$1</code>");
}

function plainTextToHtml(text, title) {
  const normalized = text.replace(/\n{3,}/g, "\n\n");
  const blocks = normalized.split(/\n\s*\n/g).map((block) => block.trim()).filter(Boolean);
  const html = [`<h1>${escapeHtml(title)}</h1>`];

  for (const block of blocks) {
    const singleLine = block.replace(/\s+/g, " ").trim();
    if (!singleLine) continue;

    const looksLikeHeading =
      singleLine.length < 90 &&
      !/[.!?,;:]$/.test(singleLine) &&
      (singleLine === singleLine.toUpperCase() || /^(глава|chapter|часть|part)\b/i.test(singleLine));

    if (looksLikeHeading) {
      html.push(`<h2>${escapeHtml(singleLine)}</h2>`);
    } else {
      html.push(`<p>${escapeHtml(singleLine)}</p>`);
    }
  }

  return html.join("\n");
}

async function parseEpub(buffer, fileName) {
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(buffer);
  const container = await zip.file("META-INF/container.xml")?.async("text");
  if (!container) throw new Error("В EPUB не найден container.xml.");

  const containerDoc = new DOMParser().parseFromString(container, "application/xml");
  const rootPath = containerDoc.querySelector("rootfile")?.getAttribute("full-path");
  if (!rootPath) throw new Error("В EPUB не найден путь к содержанию.");

  const opfText = await zip.file(rootPath)?.async("text");
  if (!opfText) throw new Error("В EPUB не найден OPF-файл.");

  const opfDoc = new DOMParser().parseFromString(opfText, "application/xml");
  const title =
    normalizeWhitespace(opfDoc.querySelector("metadata title")?.textContent) ||
    normalizeWhitespace(opfDoc.getElementsByTagName("dc:title")[0]?.textContent) ||
    niceTitleFromFile(fileName);

  const rootDir = rootPath.includes("/") ? rootPath.slice(0, rootPath.lastIndexOf("/") + 1) : "";
  const manifest = new Map();
  opfDoc.querySelectorAll("manifest item").forEach((item) => {
    manifest.set(item.getAttribute("id"), {
      href: item.getAttribute("href"),
      mediaType: item.getAttribute("media-type"),
    });
  });

  const spineItems = [...opfDoc.querySelectorAll("spine itemref")]
    .map((item) => manifest.get(item.getAttribute("idref")))
    .filter(Boolean);

  if (!spineItems.length) throw new Error("В EPUB не найден порядок глав.");

  const chapters = [];
  for (const [index, item] of spineItems.entries()) {
    const itemPath = resolveZipPath(rootDir, item.href);
    const chapterText = await zip.file(itemPath)?.async("text");
    if (!chapterText) continue;

    const chapterDoc = new DOMParser().parseFromString(chapterText, "text/html");
    chapterDoc.querySelectorAll("script, style, link, meta").forEach((node) => node.remove());
    const body = chapterDoc.body || chapterDoc.querySelector("body");
    if (!body) continue;

    await inlineEpubImages(zip, body, itemPath, manifest, rootDir);
    const sanitized = sanitizeHtml(body);
    const chapterTitle = normalizeWhitespace(body.querySelector("h1, h2, h3")?.textContent) || `Глава ${index + 1}`;
    chapters.push(`
      <section class="chapter" data-chapter="${index + 1}">
        ${sanitized.includes("<h1") || sanitized.includes("<h2") ? "" : `<h2>${escapeHtml(chapterTitle)}</h2>`}
        ${sanitized}
      </section>
      <hr class="chapter-divider" />
    `);
  }

  if (!chapters.length) throw new Error("Не удалось извлечь текст из EPUB.");
  return { title, html: chapters.join("\n") };
}

function resolveZipPath(baseDir, href) {
  const cleanHref = decodeURIComponent(String(href || "").split("#")[0]);
  const parts = `${baseDir}${cleanHref}`.split("/");
  const stack = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
}

async function inlineEpubImages(zip, body, chapterPath, manifest, rootDir) {
  const chapterDir = chapterPath.includes("/") ? chapterPath.slice(0, chapterPath.lastIndexOf("/") + 1) : "";
  const images = [...body.querySelectorAll("img")];

  for (const image of images) {
    const src = image.getAttribute("src");
    if (!src || /^data:|^https?:/i.test(src)) continue;

    const imagePath = resolveZipPath(chapterDir, src);
    const file = zip.file(imagePath);
    if (!file) continue;

    const manifestItem = [...manifest.values()].find((item) => resolveZipPath(rootDir, item.href) === imagePath);
    const mime = manifestItem?.mediaType || mimeFromPath(imagePath);
    const bytes = await file.async("uint8array");
    const blob = new Blob([bytes], { type: mime });
    image.setAttribute("src", URL.createObjectURL(blob));
  }
}

function mimeFromPath(path) {
  const ext = path.split(".").pop().toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "svg") return "image/svg+xml";
  return "image/png";
}

function sanitizeHtml(root) {
  const allowedTags = new Set([
    "A",
    "ARTICLE",
    "B",
    "BLOCKQUOTE",
    "BR",
    "CODE",
    "DIV",
    "EM",
    "FIGURE",
    "FIGCAPTION",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "HR",
    "I",
    "IMG",
    "LI",
    "OL",
    "P",
    "PRE",
    "SECTION",
    "SPAN",
    "STRONG",
    "SUB",
    "SUP",
    "TABLE",
    "TBODY",
    "TD",
    "TH",
    "THEAD",
    "TR",
    "U",
    "UL",
  ]);

  const clean = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return node.cloneNode();
    if (node.nodeType !== Node.ELEMENT_NODE) return document.createTextNode("");

    const tag = allowedTags.has(node.tagName) ? node.tagName.toLowerCase() : "span";
    const next = document.createElement(tag);

    if (tag === "a") {
      const href = node.getAttribute("href");
      if (href && !/^javascript:/i.test(href)) next.setAttribute("href", href);
    }
    if (tag === "img") {
      const src = node.getAttribute("src");
      if (src) next.setAttribute("src", src);
      next.setAttribute("alt", node.getAttribute("alt") || "");
      next.setAttribute("loading", "lazy");
    }
    if (tag === "td" || tag === "th") {
      ["colspan", "rowspan"].forEach((attr) => {
        const value = node.getAttribute(attr);
        if (value) next.setAttribute(attr, value);
      });
    }

    node.childNodes.forEach((child) => next.append(clean(child)));
    return next;
  };

  const wrapper = document.createElement("div");
  root.childNodes.forEach((child) => wrapper.append(clean(child)));
  wrapper.querySelectorAll("p, div, span").forEach((node) => {
    if (!normalizeWhitespace(node.textContent) && !node.querySelector("img")) node.remove();
  });
  return wrapper.innerHTML;
}

async function parsePdf(buffer, fileName) {
  const pdfjs = await loadPdfJs();
  const documentTask = pdfjs.getDocument({ data: new Uint8Array(buffer) });
  const pdf = await documentTask.promise;
  const title = niceTitleFromFile(fileName);
  const pages = [`<h1 class="sr-only">${escapeHtml(title)}</h1>`];
  const firstPage = await pdf.getPage(1);
  const firstViewport = firstPage.getViewport({ scale: 1 });
  const pageWidth = Math.round(firstViewport.width);
  const pageHeight = Math.round(firstViewport.height);

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    pages.push(`
      <section
        class="pdf-page"
        id="pdf-page-${pageNumber}"
        data-page="${pageNumber}"
        style="--pdf-page-width: ${pageWidth}; --pdf-page-height: ${pageHeight};"
      >
        <h2 class="sr-only">Страница ${pageNumber}</h2>
        <canvas class="pdf-canvas" aria-label="Страница ${pageNumber}"></canvas>
        <span class="pdf-page-number">${pageNumber}</span>
      </section>
    `);
  }

  return { title, html: pages.join("\n"), pdf, pageCount: pdf.numPages, isPdf: true };
}

function startPdfRendering(pdf, pageCount) {
  state.pdfObserver?.disconnect();
  state.pdf = pdf;
  state.pdfRenderToken += 1;
  state.renderedPdfPages = new Set();
  const token = state.pdfRenderToken;
  const pages = [...els.readerContent.querySelectorAll(".pdf-page")];

  const renderVisible = (entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      const pageNumber = Number(entry.target.dataset.page);
      renderPdfPage(pageNumber, token);
    });
  };

  state.pdfObserver = new IntersectionObserver(renderVisible, {
    root: els.readerViewport,
    rootMargin: "900px 0px",
    threshold: 0.01,
  });

  pages.forEach((page) => state.pdfObserver.observe(page));
  pages.slice(0, Math.min(3, pageCount)).forEach((page) => renderPdfPage(Number(page.dataset.page), token));
}

async function renderPdfPage(pageNumber, token) {
  if (!state.pdf || state.renderedPdfPages.has(pageNumber)) return;
  state.renderedPdfPages.add(pageNumber);

  const section = els.readerContent.querySelector(`[data-page="${pageNumber}"]`);
  const canvas = section?.querySelector("canvas");
  if (!section || !canvas) return;

  section.classList.add("is-rendering");
  try {
    const page = await state.pdf.getPage(pageNumber);
    if (token !== state.pdfRenderToken) return;

    const baseViewport = page.getViewport({ scale: 1 });
    section.style.setProperty("--pdf-page-width", Math.round(baseViewport.width));
    section.style.setProperty("--pdf-page-height", Math.round(baseViewport.height));
    const availableWidth = Math.max(320, section.clientWidth);
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const scale = Math.min(2.6, Math.max(1.1, (availableWidth * pixelRatio) / baseViewport.width));
    const viewport = page.getViewport({ scale });
    const context = canvas.getContext("2d", { alpha: false });

    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = "100%";
    canvas.style.height = "100%";

    await page.render({ canvasContext: context, viewport }).promise;
    section.classList.remove("is-rendering");
    section.classList.add("is-rendered");
  } catch (error) {
    console.error(error);
    section.classList.remove("is-rendering");
    section.classList.add("is-failed");
  }
}

function renderBook(html, title, ext, meta = {}) {
  const isPdf = ext === "pdf" || meta.isPdf;
  state.pdfObserver?.disconnect();
  state.pdf = null;
  state.renderedPdfPages = new Set();
  els.readerViewport.classList.toggle("pdf-mode", isPdf);
  els.readerContent.className = isPdf ? "reader-content pdf-document" : "reader-content";
  els.readerContent.innerHTML = html;
  els.bookTitle.textContent = title;
  els.bookFormat.textContent = ext.toUpperCase();
  els.bookStats.textContent = isPdf
    ? `${meta.pageCount.toLocaleString("ru-RU")} ${pluralize(meta.pageCount, ["страница", "страницы", "страниц"])}`
    : `${countWords(els.readerContent.textContent).toLocaleString("ru-RU")} слов`;
  els.savedText.textContent = "Прогресс сохранится автоматически";
  els.readerViewport.scrollTop = 0;
  buildToc();
  if (isPdf) startPdfRendering(meta.pdf, meta.pageCount);
  updateProgress();
  updateBookmarksPanel();
  refreshIcons();
}

function pluralize(value, forms) {
  const number = Math.abs(value) % 100;
  const digit = number % 10;
  if (number > 10 && number < 20) return forms[2];
  if (digit > 1 && digit < 5) return forms[1];
  if (digit === 1) return forms[0];
  return forms[2];
}

function countWords(text) {
  return normalizeWhitespace(text).split(/\s+/).filter(Boolean).length;
}

function buildToc() {
  const headings = [...els.readerContent.querySelectorAll("h1, h2, h3")].filter((heading) => normalizeWhitespace(heading.textContent));
  state.toc = headings.map((heading, index) => {
    if (!heading.id) heading.id = slugify(heading.textContent, `chapter-${index + 1}`);
    return {
      id: heading.id,
      text: normalizeWhitespace(heading.textContent),
      level: Number(heading.tagName.slice(1)),
      top: 0,
    };
  });

  if (!state.toc.length) {
    els.tocPanel.innerHTML = '<p class="empty-list">Оглавление не найдено, но читать можно сразу.</p>';
    return;
  }

  els.tocPanel.innerHTML = state.toc
    .map(
      (item, index) => `
        <button class="toc-item level-${Math.min(3, item.level)}" type="button" data-toc-index="${index}">
          ${escapeHtml(item.text)}
        </button>
      `,
    )
    .join("");
}

function refreshTocOffsets() {
  const viewportRect = els.readerViewport.getBoundingClientRect();
  state.toc.forEach((item) => {
    const heading = document.getElementById(item.id);
    if (!heading) return;
    const rect = heading.getBoundingClientRect();
    item.top = rect.top - viewportRect.top + els.readerViewport.scrollTop;
  });
}

function updateProgress() {
  const maxScroll = Math.max(1, els.readerViewport.scrollHeight - els.readerViewport.clientHeight);
  const progress = Math.min(100, Math.max(0, (els.readerViewport.scrollTop / maxScroll) * 100));
  els.progressBar.style.width = `${progress}%`;
  els.progressText.textContent = `${Math.round(progress)}%`;
  updateCurrentChapter();
  scheduleSaveProgress();
}

function updateCurrentChapter() {
  if (!state.toc.length) return;
  refreshTocOffsets();
  const current = [...state.toc].reverse().find((item) => item.top <= els.readerViewport.scrollTop + 90) || state.toc[0];
  els.chapterText.textContent = current.text;
  document.querySelectorAll(".toc-item").forEach((button) => {
    const item = state.toc[Number(button.dataset.tocIndex)];
    button.classList.toggle("active", item?.id === current.id);
  });
}

function scheduleSaveProgress() {
  if (!state.bookKey) return;
  window.clearTimeout(state.saveTimer);
  state.saveTimer = window.setTimeout(() => {
    persistCurrentBookState({ sync: true });
  }, 450);
}

function persistCurrentBookState({ sync = true } = {}) {
  if (!state.bookKey) return false;
  const store = loadStore();
  const maxScroll = Math.max(1, els.readerViewport.scrollHeight - els.readerViewport.clientHeight);
  store.books = store.books || {};
  store.books[state.bookKey] = {
    title: state.title,
    format: state.format,
    progress: els.readerViewport.scrollTop / maxScroll,
    bookmarks: state.bookmarks,
    updatedAt: Date.now(),
  };
  saveStore(store);
  if (sync) scheduleCloudSync();
  els.savedText.textContent = `Сохранено ${new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`;
  return true;
}

async function flushPendingSaves() {
  window.clearTimeout(state.saveTimer);
  const saved = persistCurrentBookState({ sync: false });
  if (saved && state.auth) {
    await syncWithServer({ silent: true });
  }
}

function restoreBookState() {
  const store = loadStore();
  const saved = store.books?.[state.bookKey];
  state.bookmarks = saved?.bookmarks || [];
  updateBookmarksPanel();

  if (saved?.progress) {
    requestAnimationFrame(() => {
      const maxScroll = Math.max(1, els.readerViewport.scrollHeight - els.readerViewport.clientHeight);
      els.readerViewport.scrollTop = saved.progress * maxScroll;
      updateProgress();
      showToast("Вернул на сохраненное место");
    });
  }
}

function addBookmark() {
  if (!state.bookKey) {
    showToast("Сначала откройте книгу");
    return;
  }

  refreshTocOffsets();
  const maxScroll = Math.max(1, els.readerViewport.scrollHeight - els.readerViewport.clientHeight);
  const current = [...state.toc].reverse().find((item) => item.top <= els.readerViewport.scrollTop + 90);
  const mark = {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    title: current?.text || state.title,
    progress: els.readerViewport.scrollTop / maxScroll,
    createdAt: Date.now(),
  };

  state.bookmarks.unshift(mark);
  updateBookmarksPanel();
  scheduleSaveProgress();
  showToast("Закладка добавлена");
}

function updateBookmarksPanel() {
  if (!state.bookmarks.length) {
    els.marksPanel.innerHTML = '<p class="empty-list">Закладок пока нет.</p>';
    return;
  }

  els.marksPanel.innerHTML = state.bookmarks
    .map(
      (mark) => `
        <div class="bookmark-item" data-mark-id="${mark.id}">
          <button class="bookmark-jump" type="button">
            <span class="bookmark-title">${escapeHtml(mark.title)}</span>
            <span class="bookmark-meta">${Math.round(mark.progress * 100)}% · ${new Date(mark.createdAt).toLocaleDateString("ru-RU")}</span>
          </button>
          <div class="bookmark-row">
            <span class="bookmark-meta">Место чтения</span>
            <button class="delete-mark" type="button" title="Удалить закладку" aria-label="Удалить закладку">
              <i data-lucide="trash-2"></i>
            </button>
          </div>
        </div>
      `,
    )
    .join("");
  refreshIcons();
}

function jumpToProgress(progress) {
  const maxScroll = Math.max(1, els.readerViewport.scrollHeight - els.readerViewport.clientHeight);
  els.readerViewport.scrollTop = progress * maxScroll;
  updateProgress();
}

function switchTab(tab) {
  const showToc = tab === "toc";
  els.tocPanel.classList.toggle("hidden", !showToc);
  els.marksPanel.classList.toggle("hidden", showToc);
  els.tocTab.classList.toggle("active", showToc);
  els.marksTab.classList.toggle("active", !showToc);
  els.tocTab.setAttribute("aria-selected", String(showToc));
  els.marksTab.setAttribute("aria-selected", String(!showToc));
}

function findNext() {
  const query = els.searchInput.value.trim();
  if (!query) {
    els.searchInput.focus();
    return;
  }
  const found = window.find(query, false, false, true, false, true, false);
  if (!found) showToast("Совпадений не найдено");
}

function refreshIcons() {
  if (window.lucide) {
    window.lucide.createIcons();
  }
}

function bindEvents() {
  els.openButton.addEventListener("click", () => els.fileInput.click());
  els.welcomeOpen.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", (event) => handleFile(event.target.files[0]));

  ["dragenter", "dragover"].forEach((eventName) => {
    els.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      els.dropZone.classList.add("is-dragging");
    });
  });

  ["dragleave", "drop"].forEach((eventName) => {
    els.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      els.dropZone.classList.remove("is-dragging");
    });
  });

  els.dropZone.addEventListener("drop", (event) => {
    const file = event.dataTransfer.files[0];
    if (file) handleFile(file);
  });

  document.querySelectorAll("[data-theme-choice]").forEach((button) => {
    button.addEventListener("click", () => {
      saveSettings({ theme: button.dataset.themeChoice });
      applySettings();
    });
  });

  els.fontSize.addEventListener("input", () => {
    saveSettings({ fontSize: Number(els.fontSize.value) });
    applySettings();
  });

  els.measure.addEventListener("input", () => {
    saveSettings({ measure: Number(els.measure.value) });
    applySettings();
  });

  els.readerViewport.addEventListener("scroll", updateProgress, { passive: true });
  document.addEventListener("wheel", handleWheelScroll, { passive: false });
  window.addEventListener("resize", updateProgress);

  els.tocPanel.addEventListener("click", (event) => {
    const button = event.target.closest(".toc-item");
    if (!button) return;
    const item = state.toc[Number(button.dataset.tocIndex)];
    const heading = item && document.getElementById(item.id);
    heading?.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  els.marksPanel.addEventListener("click", (event) => {
    const item = event.target.closest(".bookmark-item");
    if (!item) return;
    const mark = state.bookmarks.find((entry) => entry.id === item.dataset.markId);
    if (!mark) return;

    if (event.target.closest(".delete-mark")) {
      state.bookmarks = state.bookmarks.filter((entry) => entry.id !== mark.id);
      updateBookmarksPanel();
      scheduleSaveProgress();
      showToast("Закладка удалена");
      return;
    }

    jumpToProgress(mark.progress);
  });

  els.tocTab.addEventListener("click", () => switchTab("toc"));
  els.marksTab.addEventListener("click", () => switchTab("marks"));
  els.sidebarToggle.addEventListener("click", () => els.app.classList.toggle("sidebar-collapsed"));
  els.bookmarkButton.addEventListener("click", addBookmark);
  els.searchNext.addEventListener("click", findNext);
  els.searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") findNext();
  });
  els.authButton.addEventListener("click", openAuthModal);
  els.authClose.addEventListener("click", closeAuthModal);
  els.authToggle.addEventListener("click", () => setAuthMode(state.authMode === "login" ? "register" : "login"));
  [els.authName, els.authEmail, els.authPassword].forEach((input) => {
    input.addEventListener("input", () => setAuthStatus(""));
  });
  els.authForm.addEventListener("submit", handleAuthSubmit);
  els.syncNowButton.addEventListener("click", () => syncWithServer({ silent: false }));
  els.logoutButton.addEventListener("click", logout);
  els.authModal.addEventListener("click", (event) => {
    if (event.target === els.authModal) closeAuthModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !els.authModal.classList.contains("hidden")) closeAuthModal();
  });
}

function handleWheelScroll(event) {
  if (event.ctrlKey || event.metaKey || event.defaultPrevented) return;
  const scrollTarget = getPrimaryScrollTarget();
  if (!scrollTarget || scrollTarget.scrollHeight <= scrollTarget.clientHeight) return;

  const target = event.target;
  if (target instanceof Element && target.closest("input[type='range']")) return;
  if (target instanceof Element && canScrollInside(target, event.deltaY)) return;

  event.preventDefault();
  scrollTarget.scrollTop += normalizeWheelDelta(event, scrollTarget) * wheelScrollSpeed;
}

function getPrimaryScrollTarget() {
  if (els.readerViewport && els.readerViewport.scrollHeight > els.readerViewport.clientHeight) return els.readerViewport;
  return document.scrollingElement || document.documentElement;
}

function normalizeWheelDelta(event, scrollTarget) {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return event.deltaY * 40;
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return event.deltaY * scrollTarget.clientHeight;
  return event.deltaY;
}

function canScrollInside(target, deltaY) {
  let node = target;
  while (node && node !== document.body && node !== els.readerViewport) {
    const style = window.getComputedStyle(node);
    const canScroll = /(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight;
    if (canScroll) {
      const goingDown = deltaY > 0;
      const atTop = node.scrollTop <= 0;
      const atBottom = node.scrollTop + node.clientHeight >= node.scrollHeight - 1;
      if ((goingDown && !atBottom) || (!goingDown && !atTop)) return true;
    }
    node = node.parentElement;
  }
  return false;
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/service-worker.js").catch((error) => {
      console.warn("Service worker registration failed", error);
    });
  });
}

function maybeLoadDemoBook() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has("demo")) return;

  const demo = `# Северная библиотека

Это небольшой демонстрационный текст для проверки ридера. Здесь достаточно абзацев, чтобы увидеть типографику, прогресс чтения и оглавление.

## Глава первая

В комнате было тихо, но не пусто. На столе лежала раскрытая книга, рядом мерцала лампа, а за окном проходил мягкий вечерний снег.

Читать удобно тогда, когда интерфейс исчезает на втором плане: строка не слишком длинная, контраст спокойный, а настройки находятся под рукой.

## Глава вторая

Можно увеличить размер текста, поменять тему, поставить закладку и вернуться к месту позже. Ридер сохраняет прогресс для каждого файла отдельно.

> Хорошая книга не торопит. Хороший ридер тоже.

## Финал

Этот демо-текст загружается только при параметре ?demo=1 и нужен для быстрой проверки приложения.`;

  const buffer = new TextEncoder().encode(demo).buffer;
  state.bookKey = "demo-book:v1";
  state.format = "MD";
  const parsed = parseTextLike(buffer, "demo.md", "md");
  state.title = parsed.title;
  renderBook(parsed.html, parsed.title, "md");
  restoreBookState();
}

initAuth();
applySettings();
bindEvents();
maybeLoadDemoBook();
restoreLastCachedBook();
registerServiceWorker();
window.addEventListener("load", refreshIcons);
