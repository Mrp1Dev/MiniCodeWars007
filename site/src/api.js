// Talks to the FastAPI server (same origin). Every error becomes an ApiError with a message
// a beginner can act on; raw JSON and tracebacks never reach the page.

const ROLL_KEY = "mcw.roll";

export const storage = {
  get(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch { /* private mode */ }
  },
};

export const getRoll = () => storage.get(ROLL_KEY) || storage.get("mcw.token");
export const setRoll = (roll) => {
  storage.set(ROLL_KEY, roll);
  if (roll == null) storage.set("mcw.token", null);
};

export const getToken = getRoll;
export const setToken = setRoll;

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

export class ApiError extends Error {
  constructor(status, message, fields = {}) {
    super(message);
    this.status = status;
    this.fields = fields; // form field -> message, for 422s
  }
}

const sentence = (s) => {
  s = String(s).replace(/^Value error, /, "").trim();
  s = s.charAt(0).toUpperCase() + s.slice(1);
  return /[.!?)]$/.test(s) ? s : s + ".";
};

export async function api(path, { body, token = getToken(), method } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(path, {
      method: method || (body !== undefined ? "POST" : "GET"),
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "Can't reach the server. Check that you're on the event Wi-Fi and try again.");
  }
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (res.ok) return data;

  const detail = data && data.detail;
  if (Array.isArray(detail)) {
    const fields = {};
    for (const e of detail) fields[e.loc ? e.loc[e.loc.length - 1] : "form"] = sentence(e.msg);
    throw new ApiError(res.status, Object.values(fields)[0] || "Please check what you typed.", fields);
  }
  if (res.status === 401 && token) onUnauthorized();
  const fallback = res.status >= 500
    ? "The server had a problem. Wait a few seconds and try again."
    : `Something went wrong (error ${res.status}). Try again.`;
  throw new ApiError(res.status, typeof detail === "string" ? sentence(detail) : fallback);
}

const ADMIN_KEY_STORAGE = "mcw.admin_key";
export const getAdminKey = () => storage.get(ADMIN_KEY_STORAGE) || "";
export const setAdminKey = (key) => storage.set(ADMIN_KEY_STORAGE, key);

export async function adminApi(path, { body, key = getAdminKey(), method } = {}) {
  const headers = {};
  if (key) headers["X-Admin-Key"] = key;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let res;
  try {
    res = await fetch(path, {
      method: method || (body !== undefined ? "POST" : "GET"),
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "Can't reach the server. Make sure the server is running.");
  }
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (res.ok) return data;

  const detail = data && data.detail;
  if (Array.isArray(detail)) {
    const fields = {};
    for (const e of detail) fields[e.loc ? e.loc[e.loc.length - 1] : "form"] = sentence(e.msg);
    throw new ApiError(res.status, Object.values(fields)[0] || "Invalid input.", fields);
  }
  const msg = typeof detail === "string" ? sentence(detail) : `Request failed (${res.status})`;
  throw new ApiError(res.status, msg);
}
