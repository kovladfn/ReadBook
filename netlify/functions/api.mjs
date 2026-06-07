import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";

const sessionTtlMs = 1000 * 60 * 60 * 24 * 30;
const dbKey = "db";

function json(statusCode, payload) {
  return Response.json(payload, {
    status: statusCode,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

function emptyDb() {
  return { users: {}, sessions: {} };
}

function emptyUserData() {
  return {
    settings: {},
    settingsUpdatedAt: 0,
    books: {},
    updatedAt: Date.now(),
  };
}

function getDbStore() {
  return getStore({ name: "litera-reader-db", consistency: "strong" });
}

async function readDb() {
  const store = getDbStore();
  return (await store.get(dbKey, { type: "json", consistency: "strong" })) || emptyDb();
}

async function writeDb(db) {
  const store = getDbStore();
  await store.setJSON(dbKey, db);
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

function getBearerToken(request) {
  const header = request.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || "";
}

function requireUser(request, db) {
  const token = getBearerToken(request);
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

function endpointFromRequest(request) {
  const pathname = new URL(request.url).pathname;
  if (pathname.startsWith("/api/")) return pathname.slice(4);

  const marker = "/.netlify/functions/api";
  if (pathname.startsWith(marker)) {
    const endpoint = pathname.slice(marker.length);
    return endpoint || "/health";
  }

  return pathname;
}

async function parseJson(request) {
  const text = await request.text();
  if (!text) return {};
  return JSON.parse(text);
}

export default async function handler(request) {
  const endpoint = endpointFromRequest(request);
  const method = request.method.toUpperCase();

  try {
    if (method === "GET" && endpoint === "/health") {
      return json(200, { ok: true });
    }

    const db = await readDb();

    if (method === "POST" && endpoint === "/register") {
      const body = await parseJson(request);
      const email = normalizeEmail(body.email);
      const password = String(body.password || "");
      const name = String(body.name || "").trim() || email.split("@")[0] || "Reader";

      if (!email.includes("@")) return json(400, { error: "Введите email." });
      if (!validatePassword(password)) return json(400, { error: "Пароль должен быть не короче 6 символов." });
      if (findUserByEmail(db, email)) return json(409, { error: "Аккаунт с таким email уже есть." });

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
      await writeDb(db);
      return json(201, { token, user: publicUser(db.users[id]), data: db.users[id].data });
    }

    if (method === "POST" && endpoint === "/login") {
      const body = await parseJson(request);
      const email = normalizeEmail(body.email);
      const password = String(body.password || "");
      const user = findUserByEmail(db, email);

      if (!user || !verifyPassword(password, user.passwordHash)) {
        return json(401, { error: "Неверный email или пароль." });
      }

      const token = createSession(db, user.id);
      await writeDb(db);
      return json(200, { token, user: publicUser(user), data: user.data || emptyUserData() });
    }

    if (method === "POST" && endpoint === "/logout") {
      const token = getBearerToken(request);
      if (token && db.sessions[token]) {
        delete db.sessions[token];
        await writeDb(db);
      }
      return json(200, { ok: true });
    }

    if (method === "GET" && endpoint === "/me") {
      const auth = requireUser(request, db);
      if (!auth) {
        await writeDb(db);
        return json(401, { error: "Нужно войти." });
      }
      await writeDb(db);
      return json(200, { user: publicUser(auth.user), data: auth.user.data || emptyUserData() });
    }

    if (method === "GET" && endpoint === "/sync") {
      const auth = requireUser(request, db);
      if (!auth) {
        await writeDb(db);
        return json(401, { error: "Нужно войти." });
      }
      auth.user.data = auth.user.data || emptyUserData();
      await writeDb(db);
      return json(200, { data: auth.user.data });
    }

    if (method === "POST" && endpoint === "/sync") {
      const auth = requireUser(request, db);
      if (!auth) {
        await writeDb(db);
        return json(401, { error: "Нужно войти." });
      }
      const body = await parseJson(request);
      auth.user.data = mergeUserData(auth.user.data || emptyUserData(), body);
      auth.user.updatedAt = Date.now();
      await writeDb(db);
      return json(200, { data: auth.user.data });
    }

    return json(404, { error: "Not found" });
  } catch (error) {
    return json(400, { error: error.message || "Bad request" });
  }
}
