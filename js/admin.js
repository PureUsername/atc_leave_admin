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

const updateCalendarFrame = (calendarId) => {
  if (!calendarFrame) {
    return;
  }
  const src = new URL("https://calendar.google.com/calendar/embed");
  src.searchParams.set("height", "600");
  src.searchParams.set("wkst", "1");
  src.searchParams.set("bgcolor", "#ffffff");
  src.searchParams.set("ctz", TIMEZONE);
  src.searchParams.set("src", calendarId);
  src.searchParams.set("color", "#0B8043");
  src.searchParams.set("mode", "MONTH");
  src.searchParams.set("showTabs", "0");
  src.searchParams.set("showCalendars", "0");
  src.searchParams.set("showTitle", "0");
  calendarFrame.src = src.toString();
};

const renderDriversTable = () => {
  if (!driversTableBody) {
    return;
  }
  driversTableBody.innerHTML = "";
  state.drivers.forEach((driver, idx) => {
    const name = driver.display_name || "";
    const category = driver.category || "trailer";
    const checked = driver.active ? "checked" : "";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="border p-2"><input data-k="display_name" data-i="${idx}" class="w-full border rounded p-1" value="${name}"></td>
      <td class="border p-2">
        <select data-k="category" data-i="${idx}" class="w-full border rounded p-1">
          ${["trailer", "12w", "lowbed"]
            .map((option) => `<option ${category === option ? "selected" : ""} value="${option}">${option}</option>`)
            .join("")}
        </select>
      </td>
      <td class="border p-2 text-center"><input type="checkbox" data-k="active" data-i="${idx}" ${checked}></td>
      <td class="border p-2 text-center"><button data-act="del" data-i="${idx}" class="text-red-600 text-sm">Delete</button></td>
    `;
    driversTableBody.appendChild(tr);
  });
  qsa('#driversTable [data-act="del"]').forEach((btn) => {
    btn.onclick = () => {
      const index = Number(btn.dataset.i);
      state.drivers.splice(index, 1);
      renderDriversTable();
    };
  });
};

const addDriverRow = () => {
  state.drivers.push({
    driver_id: `DRV-${Math.random().toString(36).slice(2, 8)}`,
    display_name: "",
    category: "trailer",
    active: true,
  });
  renderDriversTable();
};

const persistTableEdits = () => {
  qsa("#driversTable [data-k]").forEach((input) => {
    const index = Number(input.dataset.i);
    const key = input.dataset.k;
    if (!Number.isInteger(index) || !state.drivers[index]) {
      return;
    }
    if (input.type === "checkbox") {
      state.drivers[index][key] = input.checked;
    } else {
      state.drivers[index][key] = input.value;
    }
  });
};

const saveDrivers = async () => {
  persistTableEdits();
  const upserts = state.drivers.map((driver) => ({
    driver_id: driver.driver_id,
    display_name: driver.display_name,
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
