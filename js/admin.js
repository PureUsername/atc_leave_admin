const common = window.ATCCommon;

if (!common) {
  throw new Error("ATC common helpers are not loaded. Ensure common.js runs before admin.js.");
}

const {
  ADMIN_KEY,
  CATEGORY_CHANNELS,
  DEFAULT_CALENDAR_ID,
  TIMEZONE,
  addMonthsToMonthKey,
  apiGet,
  apiPost,
  buildCalendarEmbedUrl,
  formatMonthLabel,
  listCategoryChannelConfigs,
  monthKeyInTz,
  normalizeDriver,
  qs,
  qsa,
  toast,
} = common;

const state = {
  drivers: [],
  weekendDays: [6, 0],
  calendarId: DEFAULT_CALENDAR_ID,
  maxPerDay: 3,
  deferSortUntilSave: false,
};

const CATEGORY_ORDER = ["LOWBED", "12WHEEL", "TRAILER", "KSK"];
const DEFAULT_CATEGORY = CATEGORY_ORDER.includes("TRAILER")
  ? "TRAILER"
  : CATEGORY_ORDER[CATEGORY_ORDER.length - 1] || "TRAILER";
const CATEGORY_PRIORITY = CATEGORY_ORDER.reduce((acc, category, index) => {
  acc[category] = index;
  return acc;
}, {});

const CATEGORY_CHANNEL_TO_DRIVER_CATEGORY = Object.freeze({
  LOWBED: "LOWBED",
  "12WHEEL_TRAILER": "TRAILER",
  KSK: "KSK",
});

const IMPORT_BUTTONS = Object.freeze([
  {
    id: "btnImportLowbed",
    channelId: "LOWBED",
    chatId: CATEGORY_CHANNELS?.LOWBED?.chatId || "",
  },
  {
    id: "btnImportSand",
    channelId: "12WHEEL_TRAILER",
    chatId: CATEGORY_CHANNELS?.["12WHEEL_TRAILER"]?.chatId || "",
  },
  { id: "btnImportKsk", channelId: "KSK", chatId: CATEGORY_CHANNELS?.KSK?.chatId || "" },
]);

const findImportButtonConfig = (channelId) => {
  const normalized = typeof channelId === "string" ? channelId.trim().toUpperCase() : "";
  if (!normalized) {
    return null;
  }
  return (
    IMPORT_BUTTONS.find((config) => (config.channelId || "").trim().toUpperCase() === normalized) ||
    null
  );
};

const adminKeyInput = qs("#adminKey");
const calendarIdInput = qs("#calendarId");
const weekendDaysInput = qs("#weekendDays");
const driversTableBody = qs("#driversTable tbody");
const maxPerDayLabel = qs("#maxPerDayLabel");
const calendarStack = qs("#calendarStack");
const snapshotSection = qs("#screenshots");
const shotsGrid = qs("#shotsGrid");
const snapshotMonthInput = qs("#snapshotMonth");
const calendarFrames = new Map();

const loginOverlay = qs("#loginOverlay");
const loginForm = qs("#loginForm");
const loginError = qs("#loginError");
const loginUsernameInput = qs("#loginUsername");
const loginPasswordInput = qs("#loginPassword");
const LOGIN_STORAGE_KEY = "driverLeaveAdminLoggedIn";
let adminAppInitialized = false;

const getStoredLoginStatus = () => {
  try {
    return window.sessionStorage.getItem(LOGIN_STORAGE_KEY) === "true";
  } catch (error) {
    console.warn("Unable to read login state", error);
    return false;
  }
};

const setStoredLoginStatus = () => {
  try {
    window.sessionStorage.setItem(LOGIN_STORAGE_KEY, "true");
  } catch (error) {
    console.warn("Unable to persist login state", error);
  }
};

const clearLoginError = () => {
  if (loginError) {
    loginError.classList.add("hidden");
  }
};

const showLoginError = () => {
  if (loginError) {
    loginError.classList.remove("hidden");
  }
};

const removeLoginOverlay = () => {
  if (loginOverlay) {
    loginOverlay.classList.add("hidden");
    loginOverlay.setAttribute("aria-hidden", "true");
  }
  document.body?.classList.remove("overflow-hidden");
};

const initializeAdminApp = async () => {
  if (adminAppInitialized) {
    return;
  }
  adminAppInitialized = true;
  if (snapshotMonthInput) {
    snapshotMonthInput.value = monthKeyInTz();
  }
  await loadInitialData();
  refreshDefaultSnapshots();
};

const handleLoginSubmit = async (event) => {
  event.preventDefault();
  clearLoginError();
  const username = loginUsernameInput?.value?.trim() || "";
  const password = loginPasswordInput?.value || "";
  const expectedUsername = loginOverlay?.dataset?.username?.trim() || "";
  const expectedPassword = loginOverlay?.dataset?.password || "";

  if (username === expectedUsername && password === expectedPassword) {
    setStoredLoginStatus();
    await initializeAdminApp();
    removeLoginOverlay();
    if (loginPasswordInput) {
      loginPasswordInput.value = "";
    }
  } else {
    showLoginError();
    if (loginPasswordInput) {
      loginPasswordInput.value = "";
      loginPasswordInput.focus();
    }
  }
};

loginUsernameInput?.addEventListener("input", clearLoginError);
loginPasswordInput?.addEventListener("input", clearLoginError);
loginForm?.addEventListener("submit", handleLoginSubmit);

const ensureAdminKey = () => {
  const value = adminKeyInput?.value?.trim();
  return value || ADMIN_KEY;
};

const getCategoryPriority = (category) => {
  if (!category) {
    return CATEGORY_ORDER.length;
  }
  const key = String(category).toUpperCase();
  return CATEGORY_PRIORITY[key] ?? CATEGORY_ORDER.length;
};

const sortDrivers = (drivers = []) => {
  drivers.sort((a, b) => {
    const aActive = a?.active !== false;
    const bActive = b?.active !== false;
    if (aActive !== bActive) {
      return aActive ? -1 : 1;
    }
    const categoryDiff = getCategoryPriority(a?.category) - getCategoryPriority(b?.category);
    if (categoryDiff !== 0) {
      return categoryDiff;
    }
    const nameA = (a?.display_name || "").trim();
    const nameB = (b?.display_name || "").trim();
    const nameCompare = nameA.localeCompare(nameB, undefined, { sensitivity: "base" });
    if (nameCompare !== 0) {
      return nameCompare;
    }
    return (a?.driver_id || "").localeCompare(b?.driver_id || "");
  });
};

const buildCalendarDisplayConfigs = (extraCalendarIds = []) => {
  const configs = [];
  const seen = new Set();
  listCategoryChannelConfigs().forEach((config) => {
    if (config?.calendarId && !seen.has(config.calendarId)) {
      configs.push(config);
      seen.add(config.calendarId);
    }
  });
  extraCalendarIds.forEach((calendarId) => {
    const normalized = typeof calendarId === "string" ? calendarId.trim() : "";
    if (!normalized || seen.has(normalized)) {
      return;
    }
    configs.push({
      id: normalized,
      label: "Configured Calendar",
      calendarId: normalized,
      calendarUrl: "",
    });
    seen.add(normalized);
  });
  return configs;
};

const applyCalendarSrc = (iframe, calendarId, options = {}) => {
  if (!iframe || !calendarId) {
    return;
  }
  const { refreshToken = Date.now() } = options;
  iframe.src = buildCalendarEmbedUrl(calendarId, { refreshToken, timeZone: TIMEZONE });
};

const renderCalendarEmbeds = (extraCalendarIds = []) => {
  if (!calendarStack) {
    return;
  }
  const configs = buildCalendarDisplayConfigs(extraCalendarIds);
  calendarFrames.clear();
  calendarStack.innerHTML = "";
  configs.forEach((config) => {
    const wrapper = document.createElement("div");
    wrapper.className = "space-y-2";
    const label = document.createElement("div");
    label.className = "font-semibold text-sm";
    label.textContent = config.label || config.id || "Google Calendar";
    if (label.textContent === "12WHEEL + TRAILER") {  
      label.textContent = "SAND";
    }
    const embed = document.createElement("div");
    embed.className = "calendar-embed bg-slate-100 rounded-xl overflow-hidden border";
    const iframe = document.createElement("iframe");
    iframe.className = "border-0";
    iframe.loading = "lazy";
    iframe.title = `${label.textContent}`;
    iframe.dataset.calendarId = config.calendarId;
    embed.appendChild(iframe);
    wrapper.appendChild(label);
    wrapper.appendChild(embed);
    calendarStack.appendChild(wrapper);
    calendarFrames.set(config.calendarId, iframe);
    applyCalendarSrc(iframe, config.calendarId);
  });
};

const updateCalendarFrame = (calendarId, options = {}) => {
  if (!calendarId) {
    return;
  }
  if (!calendarFrames.has(calendarId)) {
    renderCalendarEmbeds([calendarId]);
    return;
  }
  const iframe = calendarFrames.get(calendarId);
  applyCalendarSrc(iframe, calendarId, options);
};

const refreshCalendarFrames = () => {
  if (!calendarFrames.size) {
    renderCalendarEmbeds([state.calendarId]);
    return;
  }
  const refreshToken = Date.now();
  calendarFrames.forEach((iframe, calendarId) => {
    applyCalendarSrc(iframe, calendarId, { refreshToken });
  });
};

const renderDriversTable = (options = {}) => {
  if (!driversTableBody) {
    return;
  }
  const shouldSort = options.forceSort || (!state.deferSortUntilSave && !options.skipSort);
  if (shouldSort) {
    sortDrivers(state.drivers);
  }
  driversTableBody.innerHTML = "";
  state.drivers.forEach((driver, idx) => {
    const name = driver.display_name || "";
    const phone = driver.phone_number || "";
    const category = driver.category || DEFAULT_CATEGORY;
    const checked = driver.active ? "checked" : "";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="border p-2"><input data-k="display_name" data-i="${idx}" data-driver-id="${driver.driver_id || ""}" class="w-full border rounded p-1" value="${name}"></td>
      <td class="border p-2"><input data-k="phone_number" data-i="${idx}" data-driver-id="${driver.driver_id || ""}" class="w-full border rounded p-1" value="${phone}" placeholder="+60XXXXXXXXX"></td>
      <td class="border p-2">
        <select data-k="category" data-i="${idx}" data-driver-id="${driver.driver_id || ""}" class="w-full border rounded p-1">
          ${CATEGORY_ORDER
            .map((option) => `<option ${category === option ? "selected" : ""} value="${option}">${option}</option>`)
            .join("")}
        </select>
      </td>
      <td class="border p-2 text-center"><input type="checkbox" data-k="active" data-i="${idx}" data-driver-id="${driver.driver_id || ""}" ${checked}></td>
      <td class="border p-2 text-center"><button data-act="del" data-i="${idx}" class="text-red-600 text-sm">Delete</button></td>
    `;
    driversTableBody.appendChild(tr);
  });
  qsa('#driversTable [data-act="del"]').forEach((btn) => {
    btn.onclick = () => {
      persistTableEdits();
      const index = Number(btn.dataset.i);
      state.drivers.splice(index, 1);
      renderDriversTable();
    };
  });
};

function persistTableEdits() {
  qsa("#driversTable [data-k]").forEach((input) => {
    const index = Number(input.dataset.i);
    const key = input.dataset.k;
    if (!Number.isInteger(index) || !state.drivers[index]) {
      console.log(`Skipping input - index: ${index}, key: ${key}, driver exists: ${!!state.drivers[index]}`);
      return;
    }
    if (input.type === "checkbox") {
      state.drivers[index][key] = input.checked;
      console.log(`Updated driver[${index}].${key} = ${input.checked}`);
    } else {
      state.drivers[index][key] = input.value;
      console.log(`Updated driver[${index}].${key} = "${input.value}"`);
    }
  });
  console.log("Current state.drivers:", JSON.stringify(state.drivers, null, 2));
}

function focusDriverNameInput(driverId) {
  if (!driverId) {
    return;
  }
  const target = qsa('#driversTable [data-k="display_name"]').find((input) => input.dataset.driverId === driverId);
  if (target) {
    target.focus();
    if (typeof target.select === "function") {
      target.select();
    }
  }
}

const addDriverRow = () => {
  // First persist any edits in the current table
  persistTableEdits();
  
  // Add new driver row
  const newDriverId = `DRV-${Math.random().toString(36).slice(2, 8)}`;
  state.drivers.push({
    driver_id: newDriverId,
    display_name: "",
    phone_number: "",
    category: DEFAULT_CATEGORY,
    active: true,
  });
  state.deferSortUntilSave = true;
  
  // Re-render the table with the new row
  renderDriversTable({ skipSort: true });
  
  // Focus on the new row's name input for better UX
  focusDriverNameInput(newDriverId);
};

const saveDrivers = async () => {
  persistTableEdits();
  const upserts = state.drivers.map((driver) => ({
    driver_id: driver.driver_id,
    display_name: driver.display_name,
    phone_number: driver.phone_number,
    category: driver.category,
    active: driver.active !== false,
  }));
  try {
    const response = await apiPost("drivers_upsert", {
      admin_key: ensureAdminKey(),
      upserts,
    });
    if (response.ok) {
      toast("Drivers saved", "ok");
      await loadInitialData();
    } else {
      toast(`Save failed: ${response.message || ""}`, "error");
    }
  } catch (error) {
    toast(`Save failed: ${error.message}`, "error");
  }
};

const saveSettings = async () => {
  const calendarId = calendarIdInput?.value?.trim() || DEFAULT_CALENDAR_ID;
  const weekendValue = weekendDaysInput?.value?.trim() || "6,0";
  try {
    const response = await apiPost("settings_save", {
      admin_key: ensureAdminKey(),
      calendar_id: calendarId,
      weekend_days: weekendValue,
    });
    if (response.ok) {
      toast("Settings saved", "ok");
      state.calendarId = calendarId;
      updateCalendarFrame(calendarId);
      refreshDefaultSnapshots();
    } else {
      toast(`Save failed: ${response.message || ""}`, "error");
    }
  } catch (error) {
    toast(`Save failed: ${error.message}`, "error");
  }
};

const renderSnapshot = (monthIso, payload) => {
  const wrapper = document.createElement("div");
  wrapper.className = "space-y-2 calendar-shot";
  wrapper.innerHTML = `<div class="font-semibold">${formatMonthLabel(monthIso)}</div>`;
  if (payload.svgDataUrl) {
    const img = document.createElement("img");
    img.className = "border rounded shadow-sm";
    img.alt = `Calendar ${formatMonthLabel(monthIso)}`;
    img.src = payload.svgDataUrl;
    img.loading = "lazy";
    wrapper.appendChild(img);
  } else if (payload.svg) {
    const container = document.createElement("div");
    container.className = "border rounded overflow-hidden";
    container.innerHTML = payload.svg;
    const svgEl = container.querySelector("svg");
    if (svgEl) {
      svgEl.removeAttribute("width");
      svgEl.removeAttribute("height");
      svgEl.setAttribute("preserveAspectRatio", "xMidYMid meet");
    }
    wrapper.appendChild(container);
  } else {
    const note = document.createElement("div");
    note.className = "text-sm text-slate-500";
    note.textContent = "No snapshot returned.";
    wrapper.appendChild(note);
  }
  return wrapper;
};

const loadSnapshots = async (months) => {
  if (!shotsGrid || !snapshotSection) {
    return;
  }
  const uniqueMonths = Array.from(new Set(months.filter(Boolean)));
  shotsGrid.innerHTML = "";
  if (!uniqueMonths.length) {
    snapshotSection.classList.add("hidden");
    return;
  }
  let hasSnapshot = false;
  for (const month of uniqueMonths) {
    try {
      const data = await apiGet("calendar_screenshot", { month });
      if (data && data.ok) {
        shotsGrid.appendChild(renderSnapshot(month, data));
        hasSnapshot = true;
      } else {
        const failure = document.createElement("div");
        failure.className = "space-y-2 calendar-shot";
        failure.innerHTML = `<div class="font-semibold">${formatMonthLabel(month)}</div><div class="text-sm text-red-600">No snapshot available.</div>`;
        shotsGrid.appendChild(failure);
      }
    } catch (error) {
      console.error(`Failed to load calendar for ${month}`, error);
      const failure = document.createElement("div");
      failure.className = "space-y-2 calendar-shot";
      failure.innerHTML = `<div class="font-semibold">${formatMonthLabel(month)}</div><div class="text-sm text-red-600">Failed to load: ${error.message}</div>`;
      shotsGrid.appendChild(failure);
    }
  }
  if (hasSnapshot) {
    snapshotSection.classList.remove("hidden");
  } else {
    snapshotSection.classList.add("hidden");
  }
};

const refreshDefaultSnapshots = () => {
  const current = monthKeyInTz();
  const next = addMonthsToMonthKey(current, 1);
  loadSnapshots([current, next]);
};

const loadSelectedSnapshot = () => {
  const selected = snapshotMonthInput?.value;
  if (!selected) {
    toast("Choose a month to load.", "error");
    return;
  }
  loadSnapshots([selected]);
};

const loadInitialData = async () => {
  try {
    const data = await apiGet("drivers");
    state.drivers = (data.drivers || []).map(normalizeDriver);
    state.weekendDays = data.weekend_days || data.weekendDays || [6, 0];
    state.calendarId = data.calendar_id || DEFAULT_CALENDAR_ID;
    state.maxPerDay = data.max_per_day || data.max || 3;
    state.deferSortUntilSave = false;
    if (maxPerDayLabel) {
      maxPerDayLabel.textContent = String(state.maxPerDay);
    }
    if (calendarIdInput) {
      calendarIdInput.value = state.calendarId;
    }
    if (weekendDaysInput) {
      weekendDaysInput.value = Array.isArray(state.weekendDays)
        ? state.weekendDays.join(",")
        : String(state.weekendDays || "6,0");
    }
    renderDriversTable({ forceSort: true });
    renderCalendarEmbeds([state.calendarId]);
  } catch (error) {
    console.error(error);
    toast(`Failed to load admin data: ${error.message}`, "error");
  }
};

const importDriversFromChannel = async ({ channelId, chatId = "" }) => {
  const normalized = String(channelId || "").trim().toUpperCase();
  if (!normalized) {
    toast("Missing channel identifier", "error");
    return;
  }
  const fallbackConfig = CATEGORY_CHANNELS?.[normalized];
  const buttonConfig = findImportButtonConfig(normalized);
  const resolvedChatId = chatId || buttonConfig?.chatId || fallbackConfig?.chatId || "";
  if (!resolvedChatId) {
    toast("Missing WhatsApp chat ID for this channel.", "error");
    return;
  }
  const channelLabel = CATEGORY_CHANNEL_TO_DRIVER_CATEGORY[normalized] || normalized;
  try {
    toast(`Importing ${channelLabel} drivers...`, "info", { duration: 1500 });
    const result = await apiPost("whatsapp_import_drivers", {
      admin_key: ensureAdminKey(),
      channel_id: normalized,
      chat_id: resolvedChatId || undefined,
    });
    const inserted = Number(result.inserted || result?.bridge?.inserted || 0);
    const updated = Number(result.updated || result?.bridge?.updated || 0);
    const processed = Number(result.processed || result?.bridge?.processed || 0);
    toast(
      `WhatsApp import done (${processed} processed, ${inserted} new, ${updated} refreshed).`,
      "ok",
      { duration: 4000 }
    );
    await loadInitialData();
  } catch (error) {
    console.error("Driver import failed", error);
    toast(`Import failed: ${error.message}`, "error", { duration: 5000 });
  }
};

// Event bindings
qs("#btnAddDriver")?.addEventListener("click", addDriverRow);
qs("#btnSaveDrivers")?.addEventListener("click", saveDrivers);
qs("#btnReloadDrivers")?.addEventListener("click", async () => {
  await loadInitialData();
  refreshDefaultSnapshots();
  toast("Drivers reloaded", "ok");
});
qs("#btnSaveSettings")?.addEventListener("click", saveSettings);
qs("#btnRefreshCalendar")?.addEventListener("click", () => {
  refreshCalendarFrames();
  toast("Calendars refreshed", "ok");
});
qs("#btnRefreshSnapshots")?.addEventListener("click", refreshDefaultSnapshots);
qs("#btnLoadSnapshot")?.addEventListener("click", loadSelectedSnapshot);
calendarIdInput?.addEventListener("change", (event) => {
  const value = event.target.value.trim();
  if (value) {
    state.calendarId = value;
    updateCalendarFrame(value);
  }
});

IMPORT_BUTTONS.forEach(({ id, channelId, chatId }) => {
  const button = qs(`#${id}`);
  if (button) {
    button.addEventListener("click", () => importDriversFromChannel({ channelId, chatId }));
  }
});

// Initialize defaults
const bootstrapAdminApp = async () => {
  if (!loginOverlay) {
    await initializeAdminApp();
    return;
  }
  if (getStoredLoginStatus()) {
    await initializeAdminApp();
    removeLoginOverlay();
  } else {
    loginUsernameInput?.focus();
  }
};

bootstrapAdminApp();
