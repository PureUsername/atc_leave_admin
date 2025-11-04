import {
  ADMIN_KEY,
  DEFAULT_CALENDAR_ID,
  TIMEZONE,
  addMonthsToMonthKey,
  apiGet,
  apiPost,
  formatMonthLabel,
  monthKeyInTz,
  normalizeDriver,
  qs,
  qsa,
  toast,
} from "./common.js";

const state = {
  drivers: [],
  weekendDays: [6, 0],
  calendarId: DEFAULT_CALENDAR_ID,
  maxPerDay: 3,
};

const CATEGORY_ORDER = ["LOWBED", "12WHEEL", "TRAILER", "KSK"];
const DEFAULT_CATEGORY = CATEGORY_ORDER.includes("TRAILER")
  ? "TRAILER"
  : CATEGORY_ORDER[CATEGORY_ORDER.length - 1] || "TRAILER";
const CATEGORY_PRIORITY = CATEGORY_ORDER.reduce((acc, category, index) => {
  acc[category] = index;
  return acc;
}, {});

const adminKeyInput = qs("#adminKey");
const calendarIdInput = qs("#calendarId");
const weekendDaysInput = qs("#weekendDays");
const driversTableBody = qs("#driversTable tbody");
const maxPerDayLabel = qs("#maxPerDayLabel");
const calendarFrame = qs("#calendarFrame");
const snapshotSection = qs("#screenshots");
const shotsGrid = qs("#shotsGrid");
const snapshotMonthInput = qs("#snapshotMonth");

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

const updateCalendarFrame = (calendarId, options = {}) => {
  if (!calendarFrame) {
    return;
  }
  const { refreshToken = Date.now() } = options;
  const src = new URL("https://calendar.google.com/calendar/embed");
  src.searchParams.set("height", "800");
  src.searchParams.set("wkst", "1");
  src.searchParams.set("bgcolor", "#ffffff");
  src.searchParams.set("ctz", TIMEZONE);
  src.searchParams.set("src", calendarId);
  src.searchParams.set("color", "#0B8043");
  src.searchParams.set("mode", "MONTH");
  src.searchParams.set("showTabs", "0");
  src.searchParams.set("showCalendars", "0");
  src.searchParams.set("showTitle", "0");
  src.searchParams.set("refresh", String(refreshToken));
  calendarFrame.src = src.toString();
};

const renderDriversTable = () => {
  if (!driversTableBody) {
    return;
  }
  sortDrivers(state.drivers);
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
  
  // Re-render the table with the new row
  renderDriversTable();
  
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
    renderDriversTable();
    updateCalendarFrame(state.calendarId);
  } catch (error) {
    console.error(error);
    toast(`Failed to load admin data: ${error.message}`, "error");
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
  updateCalendarFrame(state.calendarId, { refreshToken: Date.now() });
  toast("Calendar refreshed", "ok");
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

// Initialize defaults
(async () => {
  if (snapshotMonthInput) {
    snapshotMonthInput.value = monthKeyInTz();
  }
  await loadInitialData();
  refreshDefaultSnapshots();
})();
