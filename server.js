const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 4173);
const rootDir = __dirname;
const dataDir = path.join(rootDir, "data");
const dbPath = path.join(dataDir, "reader-db.json");
const sessionTtlMs = 1000 * 60 * 60 * 24 * 30;

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

function ensureDb() {
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(dbPath)) {
    fs.writeFileSync(dbPath, JSON.stringify({ users: {}, sessions: {} }, null, 2));
  }
}

function readDb() {
  ensureDb();
  try {
    return JSON.parse(fs.readFileSync(dbPath, "utf8"));
  } catch {
    return { users: {}, sessions: {} };
  }
}

function writeDb(db) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
}

function json(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("Request body is too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
  });
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    createdAt: user.createdAt,
  };
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function validatePassword(password) {
  return typeof password === "string" && password.length >= 6;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  return { salt, hash };
}

function verifyPassword(password, stored) {
  const next = hashPassword(password, stored.salt);
  return crypto.timingSafeEqual(Buffer.from(next.hash, "hex"), Buffer.from(stored.hash, "hex"));
}

function findUserByEmail(db, email) {
  return Object.values(db.users).find((user) => user.email === email);
}

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString("hex");
  db.sessions[token] = {
    userId,
    createdAt: Date.now(),
    expiresAt: Date.now() + sessionTtlMs,
  };
  return token;
}

function getBearerToken(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || "";
}

function requireUser(req, db) {
  const token = getBearerToken(req);
  const session = db.sessions[token];
  if (!session || session.expiresAt < Date.now()) {
    if (session) delete db.sessions[token];
    return null;
  }
  const user = db.users[session.userId];
  if (!user) return null;
  session.expiresAt = Date.now() + sessionTtlMs;
  return { token, user };
}

function emptyUserData() {
  return {
    settings: {},
    settingsUpdatedAt: 0,
    books: {},
    updatedAt: Date.now(),
  };
}

function mergeUserData(serverData, clientData) {
  const next = serverData || emptyUserData();
  const incoming = clientData || {};
  const now = Date.now();

  if (incoming.settings && Number(incoming.settingsUpdatedAt || 0) >= Number(next.settingsUpdatedAt || 0)) {
    next.settings = incoming.settings;
    next.settingsUpdatedAt = Number(incoming.settingsUpdatedAt || now);
  }

  next.books = next.books || {};
  for (const [bookKey, book] of Object.entries(incoming.books || {})) {
    const current = next.books[bookKey];
    if (!current || Number(book.updatedAt || 0) >= Number(current.updatedAt || 0)) {
      next.books[bookKey] = {
        title: String(book.title || "Untitled").slice(0, 240),
        format: String(book.format || "").slice(0, 16),
        progress: Math.max(0, Math.min(1, Number(book.progress || 0))),
        bookmarks: Array.isArray(book.bookmarks) ? book.bookmarks.slice(0, 500) : [],
        updatedAt: Number(book.updatedAt || now),
      };
    }
  }

  next.updatedAt = now;
  return next;
}

async function handleApi(req, res, pathname) {
  const db = readDb();

  try {
    if (req.method === "GET" && pathname === "/api/health") {
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && pathname === "/api/register") {
      const body = await parseBody(req);
      const email = normalizeEmail(body.email);
      const password = String(body.password || "");
      const name = String(body.name || "").trim() || email.split("@")[0] || "Reader";

      if (!email.includes("@")) return json(res, 400, { error: "Введите email." });
      if (!validatePassword(password)) return json(res, 400, { error: "Пароль должен быть не короче 6 символов." });
      if (findUserByEmail(db, email)) return json(res, 409, { error: "Аккаунт с таким email уже есть." });

      const id = crypto.randomUUID();
      const passwordHash = hashPassword(password);
      db.users[id] = {
        id,
        email,
        name: name.slice(0, 80),
        passwordHash,
        data: emptyUserData(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      const token = createSession(db, id);
      writeDb(db);
      return json(res, 201, { token, user: publicUser(db.users[id]), data: db.users[id].data });
    }

    if (req.method === "POST" && pathname === "/api/login") {
      const body = await parseBody(req);
      const email = normalizeEmail(body.email);
      const password = String(body.password || "");
      const user = findUserByEmail(db, email);

      if (!user || !verifyPassword(password, user.passwordHash)) {
        return json(res, 401, { error: "Неверный email или пароль." });
      }

      const token = createSession(db, user.id);
      writeDb(db);
      return json(res, 200, { token, user: publicUser(user), data: user.data || emptyUserData() });
    }

    if (req.method === "POST" && pathname === "/api/logout") {
      const token = getBearerToken(req);
      if (token && db.sessions[token]) {
        delete db.sessions[token];
        writeDb(db);
      }
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && pathname === "/api/me") {
      const auth = requireUser(req, db);
      if (!auth) {
        writeDb(db);
        return json(res, 401, { error: "Нужно войти." });
      }
      writeDb(db);
      return json(res, 200, { user: publicUser(auth.user), data: auth.user.data || emptyUserData() });
    }

    if (req.method === "GET" && pathname === "/api/sync") {
      const auth = requireUser(req, db);
      if (!auth) {
        writeDb(db);
        return json(res, 401, { error: "Нужно войти." });
      }
      auth.user.data = auth.user.data || emptyUserData();
      writeDb(db);
      return json(res, 200, { data: auth.user.data });
    }

    if (req.method === "POST" && pathname === "/api/sync") {
      const auth = requireUser(req, db);
      if (!auth) {
        writeDb(db);
        return json(res, 401, { error: "Нужно войти." });
      }
      const body = await parseBody(req);
      auth.user.data = mergeUserData(auth.user.data || emptyUserData(), body);
      auth.user.updatedAt = Date.now();
      writeDb(db);
      return json(res, 200, { data: auth.user.data });
    }

    return json(res, 404, { error: "Not found" });
  } catch (error) {
    return json(res, 400, { error: error.message || "Bad request" });
  }
}

function serveStatic(req, res, pathname) {
  const requestedPath = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
  const filePath = path.normalize(path.join(rootDir, requestedPath));

  if (!filePath.startsWith(rootDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": mimeTypes[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=0",
    });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `${host}:${port}`}`);
  if (url.pathname.startsWith("/api/")) {
    await handleApi(req, res, url.pathname);
    return;
  }
  serveStatic(req, res, url.pathname);
});

server.listen(port, host, () => {
  console.log(`Litera Reader is running at http://${host}:${port}/`);
  if (host === "127.0.0.1") {
    console.log("Use HOST=0.0.0.0 to open it from another device on the same network.");
  }
});
