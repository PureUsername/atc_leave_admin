// Shared helpers for the leave management frontend views
const ADMIN_KEY = "a63b18e7b18d3291057cbcdb6c055d60f0d%d6fd^$99fac158b447dc88801f677";
const DEFAULT_API_BASE = "/atc/public";
const DEFAULT_CALENDAR_ID = "a63b18e7b18d3291057cbcdb6c055d60f0d6d6fd399fac158b447dc88801f677@group.calendar.google.com";
const TIMEZONE = "Asia/Kuala_Lumpur";

const API_BASE = (() => {
  const fromWindow = typeof window.ATC_API_BASE === "string" ? window.ATC_API_BASE.trim() : "";
  const fromMeta = (document.querySelector('meta[name="atc-api-base"]')?.content || "").trim();
  const selected = fromWindow || fromMeta || DEFAULT_API_BASE;
  return selected.replace(/\s+/g, "");
})();
const API_BASE_IS_ABSOLUTE = /^https?:\/\//i.test(API_BASE);
const NORMALIZED_API_BASE = (() => {
  const trimmed = API_BASE.replace(/\/+$/, "");
  if (API_BASE_IS_ABSOLUTE) {
    return trimmed;
  }
  const prefixed = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return `${window.location.origin}${prefixed}`;
})();

const qs = (selector, parent = document) => parent.querySelector(selector);
const qsa = (selector, parent = document) => Array.from(parent.querySelectorAll(selector));
const _fmtFormatters = new Map();
const fmt = (date, timeZone = TIMEZONE) => {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return "";
  }
  const tz = timeZone || TIMEZONE || "UTC";
  let formatter = _fmtFormatters.get(tz);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-MY", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    _fmtFormatters.set(tz, formatter);
  }
  const parts = formatter.formatToParts(date);
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  if (!year || !month || !day) {
    return "";
  }
  return `${year}-${month}-${day}`;
};
const isoToMonth = (iso) => iso.slice(0, 7);
const addDays = (date, days) => {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
};
const monthKeyInTz = (date = new Date(), timeZone = TIMEZONE) => {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit" }).formatToParts(date);
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  if (year && month) {
    return `${year}-${month}`;
  }
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
};
const addMonthsToMonthKey = (monthIso, offset) => {
  const [yStr, mStr] = monthIso.split("-");
  const year = Number(yStr);
  const monthIndex = Number(mStr) - 1;
  const totalMonths = year * 12 + monthIndex + offset;
  const newYear = Math.floor(totalMonths / 12);
  const newMonthIndex = ((totalMonths % 12) + 12) % 12;
  return `${newYear}-${String(newMonthIndex + 1).padStart(2, "0")}`;
};
const formatMonthLabel = (monthIso) => {
  const [yStr, mStr] = monthIso.split("-");
  const year = Number(yStr);
  const month = Number(mStr);
  const date = new Date(year, month - 1, 1);
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
};

const toast = (message, kind = "info", options = {}) => {
  const { position = "bottom-right", duration = 3000 } = options;
  const el = document.createElement("div");
  el.className = `fixed px-3 py-2 rounded shadow text-white ${
    kind === "ok" ? "bg-emerald-600" : kind === "error" ? "bg-red-600" : "bg-slate-900"
  }`;
  el.style.zIndex = "9999";

  switch (position) {
    case "center":
      el.style.top = "50%";
      el.style.left = "50%";
      el.style.transform = "translate(-50%, -50%)";
      break;
    case "top-right":
      el.style.top = "1rem";
      el.style.right = "1rem";
      break;
    case "top-left":
      el.style.top = "1rem";
      el.style.left = "1rem";
      break;
    case "bottom-left":
      el.style.bottom = "1rem";
      el.style.left = "1rem";
      break;
    case "bottom-right":
    default:
      el.style.bottom = "1rem";
      el.style.right = "1rem";
      break;
  }

  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), duration);
};

const normalizeDriver = (driver = {}) => {
  const rawCategory =
    driver.category ||
    driver.category_name ||
    driver.categoryName ||
    driver.category_code ||
    driver.categoryCode ||
    "";
  const normalizedCategory =
    typeof rawCategory === "string" && rawCategory.trim()
      ? rawCategory.trim().toUpperCase()
      : "TRAILER";
  return {
    driver_id: driver.driver_id || driver.driverId || "",
    display_name: driver.display_name || driver.displayName || "",
    category: normalizedCategory,
    phone_number: driver.phone_number || driver.phoneNumber || "",
    active: driver.active !== false,
    updated_at: driver.updated_at || driver.updatedAt || null,
  };
};

const resolveUrl = (endpoint) => {
  const path = endpoint.startsWith("/") ? endpoint.slice(1) : endpoint;
  const base = NORMALIZED_API_BASE.endsWith("/") ? NORMALIZED_API_BASE : `${NORMALIZED_API_BASE}/`;
  return new URL(path, base);
};

async function handleResponse(res) {
  const text = await res.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (err) {
      console.error("Failed to parse JSON response", err);
    }
  }
  if (!res.ok) {
    const message = (data && data.message) || `Request failed (${res.status})`;
    throw new Error(message);
  }
  return data;
}

const apiGet = async (endpoint, params = {}) => {
  const url = resolveUrl(endpoint);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      url.searchParams.append(key, value);
    }
  });
  const res = await fetch(url.toString(), {
    method: "GET",
    headers: { Accept: "application/json" },
    credentials: "same-origin",
  });
  return handleResponse(res);
};

const apiPost = async (endpoint, body = {}) => {
  const url = resolveUrl(endpoint);
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  return handleResponse(res);
};

export {
  ADMIN_KEY,
  DEFAULT_API_BASE,
  DEFAULT_CALENDAR_ID,
  TIMEZONE,
  API_BASE,
  NORMALIZED_API_BASE,
  qs,
  qsa,
  fmt,
  isoToMonth,
  addDays,
  monthKeyInTz,
  addMonthsToMonthKey,
  formatMonthLabel,
  toast,
  normalizeDriver,
  resolveUrl,
  apiGet,
  apiPost,
};
