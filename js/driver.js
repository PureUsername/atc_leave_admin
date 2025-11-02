import { apiGet, apiPost, addDays, fmt, normalizeDriver, qs, toast } from "./common.js";

const state = {
  drivers: [],
  weekendDays: [6, 0],
  selected: { start: null, end: null },
  hasFullDay: false,
  pendingForceStart: null,
  maxPerDay: 3,
};

const driverSelect = qs("#driverSelect");
const capacityHintContainer = qs("#capacityHints");
const statusLabel = qs("#status");
const startInput = qs("#dateStart");
const endInput = qs("#dateEnd");

const setStatus = (message) => {
  if (statusLabel) {
    statusLabel.textContent = message || "";
  }
};

const renderDriverOptions = () => {
  if (!driverSelect) return;
  driverSelect.innerHTML = "";
  state.drivers
    .filter((driver) => driver.active !== false)
    .forEach((driver) => {
      const opt = document.createElement("option");
      opt.value = driver.driver_id || "";
      const name = driver.display_name || driver.driver_id || "Unnamed Driver";
      opt.textContent = `${name}${driver.category ? ` (${driver.category})` : ""}`;
      driverSelect.appendChild(opt);
    });
  if (!driverSelect.value && driverSelect.options.length) {
    driverSelect.value = driverSelect.options[0].value;
  }
};

const collectSelectedDates = () => {
  const { start, end } = state.selected;
  if (!start || !end) {
    return [];
  }
  const dates = [];
  let cursor = new Date(start);
  const endDate = new Date(end);
  while (cursor <= endDate) {
    dates.push(fmt(cursor));
    cursor = addDays(cursor, 1);
  }
  return dates;
};

const refreshCapacityHints = async () => {
  if (!capacityHintContainer) {
    return;
  }
  const dates = collectSelectedDates();
  capacityHintContainer.innerHTML = "";
  if (!dates.length) {
    state.hasFullDay = false;
    return;
  }
  const from = dates[0];
  const to = dates[dates.length - 1];
  state.hasFullDay = false;
  try {
    const data = await apiGet("capacity", { from, to });
    const counts = data.counts || {};
    state.maxPerDay = data.max || state.maxPerDay || 3;
    dates.forEach((isoDate) => {
      const count = counts[isoDate] ?? 0;
      if (count >= state.maxPerDay) {
        state.hasFullDay = true;
      }
      const chip = document.createElement("span");
      chip.className = `chip ${
        count >= state.maxPerDay ? "chip-full" : count === state.maxPerDay - 1 ? "chip-mid" : "chip-ok"
      }`;
      chip.textContent = `${isoDate}: ${count}/${state.maxPerDay}`;
      capacityHintContainer.appendChild(chip);
    });
  } catch (error) {
    console.error(error);
    toast(`Failed to load capacity: ${error.message}`, "error");
  }
};

const loadDrivers = async () => {
  try {
    const data = await apiGet("drivers");
    state.drivers = (data.drivers || []).map(normalizeDriver);
    state.weekendDays = data.weekend_days || data.weekendDays || [6, 0];
    if (data.max_per_day) {
      state.maxPerDay = data.max_per_day;
    }
    renderDriverOptions();
    await refreshCapacityHints();
  } catch (error) {
    console.error(error);
    toast(`Failed to load drivers: ${error.message}`, "error");
  }
};

const submitForm = async () => {
  const driverId = driverSelect?.value;
  if (!driverId) {
    toast("Select a driver", "error");
    return;
  }
  const { start, end } = state.selected;
  if (!start || !end) {
    toast("Choose start & end", "error");
    return;
  }

  setStatus("Submitting...");

  try {
    const response = await apiPost("apply", {
      driver_id: driverId,
      start_date: start,
      end_date: end,
    });
    if (response.ok) {
      toast(`Applied for ${response.applied_dates.length} day(s)`, "ok");
      await afterApplied(response.applied_dates);
    } else if (response.errors) {
      state.pendingForceStart = start;
      qs("#forceModal")?.classList.remove("hidden");
      toast("Selected days are full. Consider forcing 3 working days.", "error");
    } else {
      const message = response.message || "Failed to submit leave.";
      toast(message, "error");
      setStatus(message);
    }
  } catch (error) {
    toast(`Submit failed: ${error.message}`, "error");
    setStatus("Submit failed.");
    return;
  }

  await refreshCapacityHints();
};

const confirmForce = async () => {
  if (!state.pendingForceStart) {
    toast("No force request pending", "error");
    return;
  }
  const driverId = driverSelect?.value;
  try {
    const response = await apiPost("apply_force3", {
      driver_id: driverId,
      start_date: state.pendingForceStart,
    });
    if (response.ok) {
      toast("Forced 3 working days confirmed", "ok");
      qs("#forceModal")?.classList.add("hidden");
      state.pendingForceStart = null;
      await afterApplied(response.applied_dates);
      await refreshCapacityHints();
    } else {
      toast(`Force failed: ${response.message || ""}`, "error");
    }
  } catch (error) {
    toast(`Force failed: ${error.message}`, "error");
  }
};

const afterApplied = async (dates) => {
  setStatus(`Last submission: ${dates.length} day(s) approved.`);
  await loadDrivers();
};

// Event bindings
startInput?.addEventListener("change", (event) => {
  state.selected.start = event.target.value;
  refreshCapacityHints();
});
endInput?.addEventListener("change", (event) => {
  state.selected.end = event.target.value;
  refreshCapacityHints();
});
qs("#btnSubmit")?.addEventListener("click", submitForm);
qs("#btnCancelForce")?.addEventListener("click", () => {
  qs("#forceModal")?.classList.add("hidden");
  state.pendingForceStart = null;
});
qs("#btnConfirmForce")?.addEventListener("click", confirmForce);

// Initialize
(async () => {
  await loadDrivers();
})();
