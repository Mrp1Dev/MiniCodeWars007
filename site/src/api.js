// Talks to the FastAPI server (same origin). Every error becomes an ApiError with a message
// a beginner can act on; raw JSON and tracebacks never reach the page.

const TOKEN_KEY = "mcw.token";

export const storage = {
  get(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch { /* private mode */ }
  },
};

export const getToken = () => storage.get(TOKEN_KEY);
export const setToken = (token) => storage.set(TOKEN_KEY, token);

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
