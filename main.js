// main.js

// =======================
// CONFIG BRIDGE
// =======================

if (!window.ME_GANTT_CONFIG) {
  console.error("ME_GANTT_CONFIG not found. Did you create config.js?");
}

const TRELLO_KEY = window.ME_GANTT_CONFIG?.trelloKey || "";
const TRELLO_TOKEN = window.ME_GANTT_CONFIG?.trelloToken || "";
const ME_BOARD_ID =
  window.ME_GANTT_CONFIG?.portfolioBoardId ||
  window.ME_GANTT_CONFIG?.ME_BoardId ||
  "";
const LRL_BOARD_ID = window.ME_GANTT_CONFIG?.LRL_BoardId || "";
const CALENDARS = Array.isArray(window.ME_GANTT_CONFIG?.calendars)
  ? window.ME_GANTT_CONFIG.calendars
  : [];
const CALENDAR_BY_KEY = Object.fromEntries(CALENDARS.map((c) => [c.key, c]));
const DAY_MS = 24 * 60 * 60 * 1000;
const SIDEBAR_STATE_KEY = "meGanttTreeState";
const TASK_OPEN_STATE_KEY = "meGanttOpenState";
const DATA_CACHE_KEY = "meGanttDataCache";
const DATA_CACHE_VERSION = 2;

// Label → colour mapping (tweak as you like)
const LABEL_COLOURS = {
  ME: "#ff991f", // orange
  LRL: "#0747a6", // dark blue
  Holiday: "#ff5630",
  Family: "#36b37e",
  Default: "#5e6c84",
};

// =======================
// DOM ELEMENTS
// =======================

const statusEl = document.getElementById("status");
const projectsListEl = document.getElementById("projects-list");
const summaryEl = document.getElementById("summary");
const refreshBtn = document.getElementById("refresh-btn");
const pullBtn = document.getElementById("pull-btn");
const ganttContainer = document.getElementById("gantt-container");
const companyChipsEl = document.getElementById("company-chips");
const calendarListEl = document.getElementById("calendars-list");
const calendarsHeaderEl = document.getElementById("calendars-header");
const calendarsToggleIconEl = document.getElementById("calendars-toggle-icon");
const rangeStartEl = document.getElementById("range-start");
const rangeEndEl = document.getElementById("range-end");
const rangeNavigatorEl = document.getElementById("range-navigator");
const rangeWindowEl = document.getElementById("range-window");
const projectSearchEl = document.getElementById("project-search");
const sidebarToggleEl = document.getElementById("sidebar-toggle");

const SIDEBAR_COLLAPSED_KEY = "meGanttSidebarCollapsed";

function setSidebarCollapsedClass(collapsed) {
  document.body.classList.toggle("sidebar-collapsed", collapsed);
  if (sidebarToggleEl) {
    sidebarToggleEl.textContent = collapsed ? "›" : "‹";
    sidebarToggleEl.title = collapsed ? "Show sidebar" : "Hide sidebar";
  }
}

function toggleSidebarCollapsed() {
  const next = !document.body.classList.contains("sidebar-collapsed");
  setSidebarCollapsedClass(next);
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
  } catch (err) {
    console.warn("Failed to persist sidebar collapsed state:", err);
  }
  if (window.gantt && ganttInitialized) {
    requestAnimationFrame(() => {
      if (typeof gantt.setSizes === "function") gantt.setSizes();
      gantt.render();
    });
  }
}

if (sidebarToggleEl) {
  sidebarToggleEl.addEventListener("click", toggleSidebarCollapsed);
  setSidebarCollapsedClass(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1");
}

let ganttInitialized = false;
let holidayLayerId = null;
let projectConflictLayerId = null;
let holidayTooltipEl = null;
let sidebarState = loadSidebarState();
let taskOpenState = loadTaskOpenState();
let allCards = [];
let allTasks = [];
let calendarTasksByKey = {};
let allBoardsMeta = [];
let allListMeta = {};
let allMembers = {};
let memberByCalendarKey = {};

function buildMemberByCalendarKey() {
  const map = {};
  const memberByInitials = {};
  Object.values(allMembers).forEach((m) => {
    if (m && m.initials) {
      memberByInitials[m.initials.toLowerCase()] = m.id;
    }
  });
  CALENDARS.forEach((cal) => {
    const memberId = memberByInitials[String(cal.key || "").toLowerCase()];
    if (memberId) map[cal.key] = memberId;
  });
  memberByCalendarKey = map;
}
let phasesByProjectId = {};
let activeProjectIds = new Set();
let hiddenProjectIds = new Set();
let companyFilter = {
  ME: true,
  LRL: true,
  Other: true,
};
let enabledCalendarKeys = new Set(CALENDARS.map((c) => c.key));

function getAllCalendarTasks() {
  const out = [];
  CALENDARS.forEach((cal) => {
    const tasks = calendarTasksByKey[cal.key];
    if (Array.isArray(tasks)) out.push(...tasks);
  });
  return out;
}

function isCalendarEnabled(key) {
  return enabledCalendarKeys.has(key);
}
let rangeStart = null;
let rangeEnd = null;
let projectSearchQuery = "";
let navigatorDomainStart = null;
let navigatorDomainEnd = null;
let rangeDragState = null;

// =======================
// GANTT HELPERS
// =======================

function ensureDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function escapeHtml(value) {
  return String(value || "").replace(
    /[&<>"']/g,
    (ch) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[ch] || ch)
  );
}

function formatDateForDisplay(value) {
  const date = ensureDate(value);
  return date ? date.toISOString().slice(0, 10) : "";
}

function formatDateForTask(value) {
  const date = ensureDate(value);
  return date ? date.toISOString().slice(0, 10) : null;
}

function daysBetween(start, end) {
  if (!start || !end) return 0;
  const diff = Math.max(0, end.getTime() - start.getTime());
  return Math.max(1, Math.round(diff / DAY_MS) + 1);
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && bStart <= aEnd;
}

function findConflicts(start, end, calendarItems, taskMemberIds) {
  if (!start || !end || !calendarItems || !calendarItems.length) return [];
  const memberSet =
    taskMemberIds && taskMemberIds.length ? new Set(taskMemberIds) : null;
  const conflicts = [];
  calendarItems.forEach((item) => {
    const itemStart = ensureDate(item.start);
    const itemEnd = ensureDate(item.end);
    if (!itemStart || !itemEnd) return;
    if (!rangesOverlap(start, end, itemStart, itemEnd)) return;

    const ownerId = memberByCalendarKey[item._calendarKey];
    if (ownerId && (!memberSet || !memberSet.has(ownerId))) return;

    conflicts.push({
      name: item._summary || item.name,
      start: itemStart,
      end: itemEnd,
      type: item._company || "Calendar",
      _calendarKey: item._calendarKey,
    });
  });
  return conflicts;
}

function getDefaultRange() {
  const start = new Date();
  start.setDate(start.getDate() - 7);
  const end = new Date();
  end.setMonth(end.getMonth() + 3);
  return { start, end };
}

function syncRangeInputs() {
  if (rangeStartEl) rangeStartEl.value = formatDateForTask(rangeStart);
  if (rangeEndEl) rangeEndEl.value = formatDateForTask(rangeEnd);
}

function setGanttRange(start, end, render = true) {
  if (!start || !end || end < start) return;
  rangeStart = start;
  rangeEnd = end;
  syncRangeInputs();
  updateRangeWindow();
  syncStateToUrl();
  if (render) renderGanttFiltered();
}

function setRangePreset(preset) {
  const start = new Date();
  start.setDate(start.getDate() - 7);
  const end = new Date(start);

  if (preset === "month") {
    end.setMonth(end.getMonth() + 1);
  } else if (preset === "six-months") {
    end.setMonth(end.getMonth() + 6);
  } else if (preset === "year") {
    end.setFullYear(end.getFullYear() + 1);
  } else {
    end.setMonth(end.getMonth() + 3);
  }

  setGanttRange(start, end);
}

function getNavigatorItems() {
  const projectItems = allTasks.map((task) => ({
    start: ensureDate(task.start),
    end: ensureDate(task.end),
    type: "project",
  }));
  const calendarItems = getAllCalendarTasks().map((task) => ({
    start: ensureDate(task.start),
    end: ensureDate(task.end),
    type: "calendar",
  }));

  return [...projectItems, ...calendarItems].filter(
    (item) => item.start && item.end
  );
}

function updateNavigatorDomain(items) {
  const defaultRange = getDefaultRange();
  let min = defaultRange.start;
  let max = defaultRange.end;

  items.forEach((item) => {
    if (item.start < min) min = item.start;
    if (item.end > max) max = item.end;
  });

  navigatorDomainStart = new Date(min);
  navigatorDomainEnd = new Date(max);
  if (navigatorDomainEnd <= navigatorDomainStart) {
    navigatorDomainEnd = new Date(navigatorDomainStart.getTime() + DAY_MS);
  }
}

function dateToNavigatorPercent(date) {
  if (!navigatorDomainStart || !navigatorDomainEnd) return 0;
  const total = navigatorDomainEnd - navigatorDomainStart;
  return ((date - navigatorDomainStart) / total) * 100;
}

function navigatorPercentToDate(percent) {
  const clamped = Math.max(0, Math.min(100, percent));
  const total = navigatorDomainEnd - navigatorDomainStart;
  return new Date(navigatorDomainStart.getTime() + (total * clamped) / 100);
}

function renderRangeNavigator() {
  if (!rangeNavigatorEl || !rangeWindowEl) return;

  const items = getNavigatorItems();
  updateNavigatorDomain(items);

  rangeNavigatorEl
    .querySelectorAll(".range-nav-bar")
    .forEach((node) => node.remove());

  items.forEach((item) => {
    const left = Math.max(0, Math.min(100, dateToNavigatorPercent(item.start)));
    const right = Math.max(0, Math.min(100, dateToNavigatorPercent(item.end)));
    const width = Math.max(0.4, right - left);
    const bar = document.createElement("div");
    bar.className = `range-nav-bar ${item.type}`;
    bar.style.left = `${left}%`;
    bar.style.width = `${width}%`;
    rangeNavigatorEl.insertBefore(bar, rangeWindowEl);
  });

  updateRangeWindow();
}

function updateRangeWindow() {
  if (!rangeWindowEl || !rangeStart || !rangeEnd || !navigatorDomainStart) {
    return;
  }
  const left = Math.max(0, Math.min(100, dateToNavigatorPercent(rangeStart)));
  const right = Math.max(0, Math.min(100, dateToNavigatorPercent(rangeEnd)));
  rangeWindowEl.style.left = `${left}%`;
  rangeWindowEl.style.width = `${Math.max(1, right - left)}%`;
}

function getHolidayTooltipEl() {
  if (holidayTooltipEl) return holidayTooltipEl;
  const div = document.createElement("div");
  div.className = "holiday-tooltip";
  div.style.position = "absolute";
  div.style.zIndex = "9999";
  div.style.pointerEvents = "none";
  div.style.display = "none";
  document.body.appendChild(div);
  holidayTooltipEl = div;
  return holidayTooltipEl;
}

function hideHolidayTooltip() {
  if (holidayTooltipEl) {
    holidayTooltipEl.style.display = "none";
  }
}

function showHolidayTooltip(segment, evt) {
  const tooltip = getHolidayTooltipEl();
  const start = ensureDate(segment._startDate || segment.start_date);
  const end = ensureDate(
    segment._endDate ||
      (segment.duration
        ? new Date(
            ensureDate(segment._startDate || segment.start_date).getTime() +
              segment.duration * DAY_MS
          )
        : segment.end_date)
  );

  const url = segment._shortUrl
    ? `<div><a href="${escapeHtml(
        segment._shortUrl
      )}" target="_blank">Open in Trello</a></div>`
    : "";

  const detailsText = (segment._details || segment._summary || "").trim();
  const detailsHtml = detailsText
    ? `<div class="holiday-details">${escapeHtml(detailsText).replace(
        /\n/g,
        "<br>"
      )}</div>`
    : "";

  const dateRange = `${formatDateForDisplay(start)} → ${formatDateForDisplay(
    end
  )}`;

  tooltip.innerHTML = `
    <div class="holiday-tooltip-card" data-segment-id="${escapeHtml(
      segment.id || ""
    )}">
      <div class="holiday-tooltip-header">
        <span class="holiday-chip">${escapeHtml(segment._company || "Holiday")}</span>
        <span class="holiday-dates">${escapeHtml(dateRange)}</span>
      </div>
      <div class="holiday-title">${escapeHtml(
        segment._summary || segment.name || "Holiday"
      )}</div>
      ${detailsHtml}
      ${url ? `<div class="holiday-links">${url}</div>` : ""}
    </div>
  `;
  tooltip.style.display = "block";
  tooltip.style.left = `${evt.pageX + 12}px`;
  tooltip.style.top = `${evt.pageY + 12}px`;
}

function ensureHolidayTaskLayer() {
  if (!window.gantt || holidayLayerId !== null) return;

  holidayLayerId = gantt.addTaskLayer((task) => {
    if (!task._isHolidayLane || !Array.isArray(task._segments)) {
      return null;
    }

    const wrapper = document.createElement("div");
    wrapper.className = "holiday-layer";
    wrapper.style.zIndex = "15";
    const top = gantt.getTaskTop(task.id);
    const height = gantt.config.row_height || 36;
    if (typeof top === "number") {
      wrapper.style.top = `${top}px`;
    }
    wrapper.style.height = `${height}px`;

    task._segments.forEach((segment) => {
      const start = ensureDate(segment._startDate || segment.start_date);
      if (!start) return;
      const durationMs = (segment.duration || 1) * DAY_MS;
      const end =
        segment._endDate ||
        new Date(start.getTime() + durationMs - 1); // inclusive

      const startPos = gantt.posFromDate(start);
      const endPos = gantt.posFromDate(
        ensureDate(end) || new Date(start.getTime() + durationMs)
      );
      const width = Math.max(4, endPos - startPos);

      const segmentEl = document.createElement("div");
      segmentEl.className = "holiday-layer-segment";
      segmentEl.style.left = `${startPos}px`;
      segmentEl.style.width = `${width}px`;
      segmentEl.dataset.segmentId = segment.id;
      segmentEl.dataset.segmentSummary = segment._summary || segment.name || "";
      const segColor = segment._color || LABEL_COLOURS.Holiday || "#ff5630";
      segmentEl.style.background = segColor;
      segmentEl.style.borderColor = segColor;

      const label = segment._summary || segment.name || "";
      if (label && width >= 80) {
        const labelEl = document.createElement("span");
        labelEl.className = "holiday-layer-label";
        labelEl.textContent = label;
        segmentEl.appendChild(labelEl);
      }

      segmentEl.addEventListener("mouseenter", (evt) =>
        showHolidayTooltip(segment, evt)
      );
      segmentEl.addEventListener("mousemove", (evt) =>
        showHolidayTooltip(segment, evt)
      );
      segmentEl.addEventListener("mouseleave", () => hideHolidayTooltip());

      wrapper.appendChild(segmentEl);
    });

    return wrapper;
  });

  gantt.event(window, "scroll", hideHolidayTooltip);
}

function ensureProjectConflictLayer() {
  if (!window.gantt || projectConflictLayerId !== null) return;

  projectConflictLayerId = gantt.addTaskLayer((task) => {
    if (
      task._isHolidayLane ||
      task._isCalendarGroup ||
      task._isCompanyGroup
    ) {
      return null;
    }
    const conflicts = Array.isArray(task._conflicts) ? task._conflicts : [];
    if (!conflicts.length) return null;

    const taskStart = ensureDate(task.start_date);
    const taskEnd = ensureDate(task.end_date);
    if (!taskStart || !taskEnd) return null;

    const wrapper = document.createElement("div");
    wrapper.className = "project-conflict-layer";
    wrapper.style.position = "absolute";
    wrapper.style.pointerEvents = "none";

    const top = gantt.getTaskTop(task.id);
    const rowHeight = gantt.config.row_height || 36;
    const barHeight = gantt.config.bar_height || 24;
    const barTopOffset = Math.max(0, Math.round((rowHeight - barHeight) / 2));
    if (typeof top === "number") {
      wrapper.style.top = `${top + barTopOffset}px`;
    }
    wrapper.style.height = `${barHeight}px`;

    conflicts.forEach((conflict) => {
      const cStart = conflict.start > taskStart ? conflict.start : taskStart;
      const cEnd = conflict.end < taskEnd ? conflict.end : taskEnd;
      if (cEnd < cStart) return;

      const x1 = gantt.posFromDate(cStart);
      const x2 = gantt.posFromDate(cEnd);
      const width = Math.max(2, x2 - x1);

      const seg = document.createElement("div");
      seg.className = "project-conflict-segment";
      seg.style.position = "absolute";
      seg.style.left = `${x1}px`;
      seg.style.width = `${width}px`;
      seg.style.top = "0";
      seg.style.height = "100%";
      seg.title = conflict.name;
      wrapper.appendChild(seg);
    });

    return wrapper;
  });
}

function ensureGanttElement() {
  let ganttEl = document.getElementById("gantt");
  if (!ganttEl) {
    ganttContainer.textContent = "";
    ganttEl = document.createElement("div");
    ganttEl.id = "gantt";
    ganttContainer.appendChild(ganttEl);
  }
  return ganttEl;
}

function renderTodayLineOverlay() {
  if (!window.gantt || !gantt.$task_data) return;

  const oldLine = gantt.$task_data.querySelector(".today-line-overlay");
  if (oldLine) oldLine.remove();

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const state = gantt.getState();
  if (today < state.min_date || today > state.max_date) return;

  const line = document.createElement("div");
  line.className = "today-line-overlay";
  line.style.left = `${gantt.posFromDate(today)}px`;
  line.style.height = `${Math.max(gantt.$task_data.scrollHeight, 1)}px`;
  gantt.$task_data.appendChild(line);
}

function loadSidebarState() {
  try {
    const raw = localStorage.getItem(SIDEBAR_STATE_KEY);
    if (!raw) {
      return { companyCollapsed: {}, listCollapsed: {}, calendarsCollapsed: false };
    }
    const parsed = JSON.parse(raw);
    return {
      companyCollapsed: parsed.companyCollapsed || {},
      listCollapsed: parsed.listCollapsed || {},
      calendarsCollapsed: Boolean(parsed.calendarsCollapsed),
    };
  } catch (err) {
    console.warn("Failed to load sidebar state:", err);
    return { companyCollapsed: {}, listCollapsed: {}, calendarsCollapsed: false };
  }
}

function saveSidebarState() {
  try {
    localStorage.setItem(SIDEBAR_STATE_KEY, JSON.stringify(sidebarState));
  } catch (err) {
    console.warn("Failed to persist sidebar state:", err);
  }
}

function loadTaskOpenState() {
  try {
    const raw = localStorage.getItem(TASK_OPEN_STATE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    console.warn("Failed to load task open state:", err);
    return {};
  }
}

function saveTaskOpenState() {
  try {
    localStorage.setItem(TASK_OPEN_STATE_KEY, JSON.stringify(taskOpenState));
  } catch (err) {
    console.warn("Failed to persist task open state:", err);
  }
}

function dateToISO(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function serializeCalendarTasks(tasks) {
  return tasks.map((t) => ({
    ...t,
    start: dateToISO(t.start),
    end: dateToISO(t.end),
  }));
}

function hydrateCalendarTasks(tasks) {
  return tasks.map((t) => ({
    ...t,
    start: ensureDate(t.start),
    end: ensureDate(t.end),
  }));
}

function serializeCalendarTasksByKey(map) {
  const out = {};
  Object.entries(map).forEach(([key, tasks]) => {
    out[key] = serializeCalendarTasks(tasks || []);
  });
  return out;
}

function hydrateCalendarTasksByKey(map) {
  const out = {};
  Object.entries(map).forEach(([key, tasks]) => {
    out[key] = hydrateCalendarTasks(tasks || []);
  });
  return out;
}

function serializePhaseMap(map) {
  const out = {};
  Object.entries(map).forEach(([projectId, phases]) => {
    out[projectId] = phases.map((p) => ({
      ...p,
      start: dateToISO(p.start),
      end: dateToISO(p.end),
    }));
  });
  return out;
}

function hydratePhaseMap(map) {
  const out = {};
  Object.entries(map).forEach(([projectId, phases]) => {
    out[projectId] = phases.map((p) => ({
      ...p,
      start: ensureDate(p.start),
      end: ensureDate(p.end),
    }));
  });
  return out;
}

function saveDataCache() {
  try {
    const payload = {
      version: DATA_CACHE_VERSION,
      savedAt: Date.now(),
      cards: allCards,
      calendarTasksByKey: serializeCalendarTasksByKey(calendarTasksByKey),
      phasesByProjectId: serializePhaseMap(phasesByProjectId),
      boardsMeta: allBoardsMeta,
      listMeta: allListMeta,
      members: allMembers,
    };
    localStorage.setItem(DATA_CACHE_KEY, JSON.stringify(payload));
  } catch (err) {
    console.warn("Failed to save data cache:", err);
  }
}

function loadDataCache() {
  try {
    const raw = localStorage.getItem(DATA_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed.version !== DATA_CACHE_VERSION) return null;
    return {
      savedAt: parsed.savedAt,
      cards: parsed.cards || [],
      calendarTasksByKey: hydrateCalendarTasksByKey(
        parsed.calendarTasksByKey || {}
      ),
      phasesByProjectId: hydratePhaseMap(parsed.phasesByProjectId || {}),
      boardsMeta: parsed.boardsMeta || [],
      listMeta: parsed.listMeta || {},
      members: parsed.members || {},
    };
  } catch (err) {
    console.warn("Failed to load data cache:", err);
    return null;
  }
}

function formatRelativeAge(timestamp) {
  if (!timestamp) return "unknown";
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function hydrateFromCache(cache) {
  allCards = cache.cards;
  phasesByProjectId = cache.phasesByProjectId;
  allListMeta = cache.listMeta;
  allBoardsMeta = cache.boardsMeta;
  allMembers = cache.members;
  buildMemberByCalendarKey();
  calendarTasksByKey = cache.calendarTasksByKey || {};
  allTasks = mapCardsToTasks(cache.cards);
  renderCompanyChips();
  renderSidebar(cache.cards);
  renderGanttFiltered();
}

// =======================
// URL STATE
// =======================

const URL_SYNC_DEBOUNCE_MS = 250;
let urlSyncTimer = null;

function applyUrlState() {
  const params = new URLSearchParams(window.location.search);

  const co = params.get("co");
  if (co !== null) {
    const enabled = new Set(
      co
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    );
    companyFilter = {
      ME: enabled.has("me"),
      LRL: enabled.has("lrl"),
      Other: enabled.has("other"),
    };
  }

  const hide = params.get("hide");
  if (hide !== null) {
    hiddenProjectIds = new Set(
      hide
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    );
  }

  const cal = params.get("cal");
  if (cal !== null) {
    const requested = new Set(
      cal
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    );
    enabledCalendarKeys = new Set(
      CALENDARS.map((c) => c.key).filter((k) => requested.has(k))
    );
  }

  const from = params.get("from");
  const to = params.get("to");
  if (from && to) {
    const fromDate = parseDateInput(from);
    const toDate = parseDateInput(to);
    if (fromDate && toDate && toDate >= fromDate) {
      rangeStart = fromDate;
      rangeEnd = toDate;
      syncRangeInputs();
    }
  }
}

function syncStateToUrl() {
  clearTimeout(urlSyncTimer);
  urlSyncTimer = setTimeout(() => {
    const params = new URLSearchParams();

    const enabledCompanies = ["ME", "LRL", "Other"].filter(
      (k) => companyFilter[k]
    );
    if (enabledCompanies.length < 3) {
      params.set("co", enabledCompanies.map((s) => s.toLowerCase()).join(","));
    }

    const taskIdSet = new Set(allTasks.map((t) => t.id));
    const hiddenIds = [...hiddenProjectIds].filter((id) => taskIdSet.has(id));
    if (hiddenIds.length) {
      params.set("hide", hiddenIds.join(","));
    }

    const allKeys = CALENDARS.map((c) => c.key);
    const enabledList = allKeys.filter((k) => enabledCalendarKeys.has(k));
    if (enabledList.length < allKeys.length) {
      params.set("cal", enabledList.join(","));
    }

    if (rangeStart) params.set("from", formatDateForTask(rangeStart));
    if (rangeEnd) params.set("to", formatDateForTask(rangeEnd));

    const qs = params.toString();
    const url = qs
      ? `${window.location.pathname}?${qs}`
      : window.location.pathname;
    window.history.replaceState(null, "", url);
  }, URL_SYNC_DEBOUNCE_MS);
}

async function updateTrelloCardDates(cardId, startDate, endDate) {
  if (!cardId || !startDate || !endDate) return false;
  if (!TRELLO_KEY || !TRELLO_TOKEN) return false;

  const url = `https://api.trello.com/1/cards/${cardId}`;
  const params = new URLSearchParams();
  params.set("key", TRELLO_KEY);
  params.set("token", TRELLO_TOKEN);
  params.set("start", startDate.toISOString());
  params.set("due", endDate.toISOString());

  try {
    const res = await fetch(`${url}?${params.toString()}`, {
      method: "PUT",
    });
    if (!res.ok) {
      throw new Error(`Trello update failed: ${res.status} ${res.statusText}`);
    }
    console.log(`Updated Trello card ${cardId} dates to`, {
      start: startDate.toISOString(),
      due: endDate.toISOString(),
    });
    return true;
  } catch (err) {
    console.warn("Failed to update Trello card dates:", err);
    return false;
  }
}

function parseDateInput(value) {
  if (!value) return null;
  const parsed = new Date(`${value}T12:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getDoneListIdForCard(card) {
  const company = card._listMeta?.company;
  const doneList = Object.values(allListMeta).find(
    (list) => list.company === company && isDoneListName(list.name)
  );
  return doneList?.id || null;
}

async function moveTrelloCardToList(cardId, listId) {
  if (!cardId || !listId) return false;
  if (!TRELLO_KEY || !TRELLO_TOKEN) return false;

  const url = `https://api.trello.com/1/cards/${cardId}`;
  const params = new URLSearchParams();
  params.set("key", TRELLO_KEY);
  params.set("token", TRELLO_TOKEN);
  params.set("idList", listId);

  try {
    const res = await fetch(`${url}?${params.toString()}`, {
      method: "PUT",
    });
    if (!res.ok) {
      throw new Error(`Trello move failed: ${res.status} ${res.statusText}`);
    }
    return true;
  } catch (err) {
    console.warn("Failed to move Trello card:", err);
    return false;
  }
}

async function moveCardToDone(card) {
  if (isDoneListName(card._listMeta?.name)) return;

  const doneListId = getDoneListIdForCard(card);
  if (!doneListId) {
    window.alert(`Could not find a Done list for ${card._listMeta?.company}.`);
    return;
  }

  const confirmed = window.confirm(`Move “${card.name}” to Done?`);
  if (!confirmed) return;

  setStatus(`Moving ${card.name} to Done…`);
  const moved = await moveTrelloCardToList(card.id, doneListId);
  if (moved) {
    await loadFromTrello();
  } else {
    setStatus(`Could not move ${card.name} to Done. Check console for details.`);
  }
}

async function saveCardDateInputs(card, startInput, endInput) {
  const startDate = parseDateInput(startInput.value.trim());
  const endDate = parseDateInput(endInput.value.trim());
  if (!startDate || !endDate) {
    window.alert("Please choose both a start and end/due date.");
    return;
  }
  if (endDate < startDate) {
    window.alert("End/due date must be on or after the start date.");
    return;
  }

  setStatus(`Saving dates for ${card.name}…`);
  const saved = await updateTrelloCardDates(card.id, startDate, endDate);
  if (saved) {
    await loadFromTrello();
  } else {
    setStatus(
      `Could not save dates for ${card.name}. Check console for details.`
    );
  }
}

function persistTrelloTaskDates(task) {
  if (!isEditableTrelloTask(task)) return;
  const cardId = task._cardId || task.id;
  const start = ensureDate(task.start_date || task.start);
  const end = ensureDate(task.end_date || task.end);
  if (!cardId || !start || !end) return;
  updateTrelloCardDates(cardId, start, end);
}

function showEmptyState(message) {
  hideEmptyState();
  const div = document.createElement("div");
  div.id = "gantt-empty-state";
  div.textContent = message;
  ganttContainer.appendChild(div);
}

function hideEmptyState() {
  const node = document.getElementById("gantt-empty-state");
  if (node && node.parentNode) {
    node.parentNode.removeChild(node);
  }
}

function setupDHTMLXGantt() {
  if (!window.gantt) {
    console.error("dhtmlxGantt is not available.");
    return false;
  }

  ensureGanttElement();

  if (ganttInitialized) return true;

  if (gantt.plugins) {
    gantt.plugins({
      tooltip: true,
      split_tasks: true,
      marker: true,
    });
  }

  gantt.config.readonly = false;
  gantt.config.show_grid = true;
  gantt.config.grid_width = 220;
  gantt.config.drag_move = true;
  gantt.config.drag_progress = false;
  gantt.config.drag_links = false;
  gantt.config.drag_resize = true;
  gantt.config.auto_types = false;
  gantt.config.autosize = "y";
  gantt.config.row_height = 36;
  gantt.config.bar_height = 24;
  gantt.config.show_markers = true;
  gantt.config.scale_height = 60;
  gantt.config.fit_tasks = false;
  gantt.config.date_format = "%Y-%m-%d";
  gantt.config.scales = [
    {
      unit: "month",
      step: 1,
      format: (date) =>
        date.toLocaleString(undefined, { month: "long", year: "numeric" }),
    },
    {
      unit: "week",
      step: 1,
      format: (date) => {
        const end = new Date(date);
        end.setDate(end.getDate() + 6);
        const startStr = date.toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        });
        const endStr = end.toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        });
        return `${startStr} – ${endStr}`;
      },
    },
  ];

  gantt.config.columns = [
    {
      name: "text",
      label: "Project",
      tree: true,
      width: "*",
      align: "left",
      template: (task) => {
        const cls =
          task._isCompanyGroup || task._isCalendarGroup
            ? "gantt-grid-label company-group-label"
            : "gantt-grid-label";
        return `<span class="${cls}">${task.text}</span>`;
      },
    },
  ];

  const blank = () => "";
  delete gantt.templates.grid_folder;
  delete gantt.templates.grid_open;
  gantt.templates.grid_file = blank;

  gantt.attachEvent("onBeforeTooltip", (id) => {
    // DHTMLX can occasionally call this with a MouseEvent if bound incorrectly; ignore non-task ids
    if (!gantt.isTaskExists(id)) return false;
    const task = gantt.getTask(id);
    if (task?._isHolidayLane) return false;
    if (task?._isCompanyGroup) return false;
    if (task?._isCalendarGroup) return false;
    return true;
  });

  gantt.attachEvent("onBeforeTaskDrag", (id, mode) => {
    const task = gantt.isTaskExists(id) ? gantt.getTask(id) : null;
    if (!isEditableTrelloTask(task)) return false;
    if (mode === "progress") return false;
    return true;
  });

  gantt.attachEvent("onTaskOpened", (id) => {
    taskOpenState[id] = true;
    saveTaskOpenState();
    return true;
  });

  gantt.attachEvent("onTaskClosed", (id) => {
    taskOpenState[id] = false;
    saveTaskOpenState();
    return true;
  });

  gantt.attachEvent("onAfterTaskDrag", (id, mode) => {
    if (mode !== "move" && mode !== "resize") return true;
    const task = gantt.isTaskExists(id) ? gantt.getTask(id) : null;
    persistTrelloTaskDates(task);
    return true;
  });

  gantt.templates.tooltip_text = (start, end, task) => {
    if (task._isHolidayLane && Array.isArray(task.segments)) {
      const match =
        task.segments.find((segment) => {
          const segStart = ensureDate(segment.start_date);
          const segEnd = ensureDate(segment.end_date);
          if (!segStart || !segEnd) return false;
          return start >= segStart && start <= segEnd;
        }) || task.segments[0];

      const company = escapeHtml(match?._company || "Holiday");
      const name = escapeHtml(
        match?._summary || match?.name || task.text || "Holiday"
      );
      const shortUrl = match?._shortUrl;
      const detailsText =
        (match?._details || "").trim() || match?._summary || "";
      const detailsHtml = detailsText
        ? `<div class="holiday-details">${escapeHtml(detailsText).replace(
            /\n/g,
            "<br>"
          )}</div>`
        : "";
      const url = shortUrl
        ? `<div class="holiday-links"><a href="${escapeHtml(
            shortUrl
          )}" target="_blank">Open in Trello</a></div>`
        : "";
      const dateRange = `${formatDateForDisplay(start)} → ${formatDateForDisplay(
        end
      )}`;

      return `
        <div class="holiday-tooltip-card">
          <div class="holiday-tooltip-header">
            <span class="holiday-chip">${company}</span>
            <span class="holiday-dates">${escapeHtml(dateRange)}</span>
          </div>
          <div class="holiday-title">${name}</div>
          ${detailsHtml}
          ${url}
        </div>
      `;
    }

    const url = task._shortUrl
      ? `<div><a href="${escapeHtml(task._shortUrl)}" target="_blank">Open in Trello</a></div>`
      : "";

    const progressPct = Math.round((task.progress || 0) * 100);
    const progressLine =
      task._isHolidayLane || task._laneType === "Family"
        ? ""
        : `<p>Progress: ${progressPct}%${
            task._dueComplete ? " (marked complete in Trello)" : ""
          }</p>`;

    const memberNames = (task._memberIds || [])
      .map((id) => allMembers[id]?.fullName)
      .filter(Boolean);
    const memberLine = memberNames.length
      ? `<p>Assigned: ${escapeHtml(memberNames.join(", "))}</p>`
      : "";

    return `
      <div class="details-container">
        <h5>${escapeHtml(task.text)}</h5>
        <p>${escapeHtml(formatDateForDisplay(start))} → ${escapeHtml(
      formatDateForDisplay(end)
    )}</p>
        <p>Company: ${escapeHtml(task._company || "Unknown")}</p>
        ${progressLine}
        ${memberLine}
        ${url}
      </div>
    `;
  };

  gantt.templates.task_text = (_start, _end, task) => {
    if (task._isHolidayLane || task._isCompanyGroup || task._isCalendarGroup)
      return "";
    const text = escapeHtml(task.text || "");
    const ids = (task._memberIds || []).filter((id) => allMembers[id]);
    if (!ids.length) return text;

    const max = 4;
    const visible = ids.slice(0, max);
    const overflow = ids.length - visible.length;

    const avatars = visible
      .map((id) => {
        const m = allMembers[id];
        const name = escapeHtml(m.fullName || m.initials || "");
        if (m.avatarUrl) {
          return `<img class="bar-avatar" src="${escapeHtml(
            m.avatarUrl
          )}/30.png" alt="${name}" title="${name}" />`;
        }
        return `<span class="bar-avatar bar-avatar-initials" title="${name}">${escapeHtml(
          m.initials || "?"
        )}</span>`;
      })
      .join("");

    const overflowHtml =
      overflow > 0
        ? `<span class="bar-avatar bar-avatar-more">+${overflow}</span>`
        : "";

    return `<span class="bar-text">${text}</span><span class="bar-avatars">${avatars}${overflowHtml}</span>`;
  };

  gantt.templates.task_class = (_start, _end, task) => {
    const classes = [];
    if (task._company === "Holiday") classes.push("holiday-task");
    if (task._company === "Debug") classes.push("debug-task");
    if (task._isHolidayLane) classes.push("holiday-lane");
    if (task.id === "family-lane" || task._laneType === "Family")
      classes.push("family-lane");
    if (task._isCompanyGroup) classes.push("company-group-task");
    if (task._isCalendarGroup) classes.push("company-group-task");
    return classes.join(" ");
  };

  gantt.init("gantt");
  ensureHolidayTaskLayer();
  ensureProjectConflictLayer();
  gantt.attachEvent("onTaskDblClick", (id) => {
    const task = gantt.getTask(id);
    if (task?._shortUrl) {
      window.open(task._shortUrl, "_blank", "noopener");
      return false;
    }
    return true;
  });
  ganttInitialized = true;
  return true;
}

// =======================
// HELPERS
// =======================

function setStatus(msg) {
  if (statusEl) statusEl.textContent = msg;
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function inferCompanyFromLabels(labels) {
  if (!labels || !labels.length) return "Other";
  const names = labels.map((l) => (l.name || "").toUpperCase());
  if (names.includes("ME")) return "ME";
  if (names.includes("LRL")) return "LRL";
  return "Other";
}

function isEditableTrelloTask(task) {
  if (!task) return false;
  if (task._isHolidayLane) return false;
  if (task._isCalendarGroup) return false;
  if (task._calendarKey) return false;
  if (task._company === "Debug") return false;
  const cardId = task._cardId || task.id;
  return Boolean(cardId);
}

function unfoldICSLines(raw) {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const unfolded = [];
  lines.forEach((line) => {
    if (!line) return;
    if (/^[ \t]/.test(line) && unfolded.length) {
      unfolded[unfolded.length - 1] += line.slice(1);
    } else {
      unfolded.push(line);
    }
  });
  return unfolded;
}

function normalizeProjectName(name) {
  if (!name) return "";
  return String(name).replace(/^(ME|LRL)\s+/i, "").trim();
}

function inferCompanyFromBoardName(name) {
  if (!name) return "Other";
  if (/^ME\s+/i.test(name)) return "ME";
  if (/^LRL\s+/i.test(name)) return "LRL";
  return "Other";
}

function unescapeICSText(value) {
  if (!value) return "";
  return String(value)
    .replace(/\\n/g, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

function stripHtml(value) {
  if (!value) return "";
  const withBreaks = String(value)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n");
  return withBreaks.replace(/<[^>]+>/g, "").trim();
}

function parseICSTimestamp(value) {
  if (!value) return null;

  const isDateOnly = /^\d{8}$/.test(value) || /VALUE=DATE/.test(value);
  const cleaned = value.replace(/^.*:/, "");

  if (/^\d{8}$/.test(cleaned)) {
    const y = parseInt(cleaned.slice(0, 4), 10);
    const m = parseInt(cleaned.slice(4, 6), 10) - 1;
    const d = parseInt(cleaned.slice(6, 8), 10);
    return { date: new Date(Date.UTC(y, m, d)), isDateOnly: true };
  }

  const match = cleaned.match(
    /(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?/
  );
  if (!match) return null;

  const [, year, month, day, hour, minute, second, isZulu] = match;
  const y = parseInt(year, 10);
  const m = parseInt(month, 10) - 1;
  const d = parseInt(day, 10);
  const hh = parseInt(hour, 10);
  const mm = parseInt(minute, 10);
  const ss = parseInt(second, 10);

  const date = isZulu
    ? new Date(Date.UTC(y, m, d, hh, mm, ss))
    : new Date(y, m, d, hh, mm, ss);

  return { date, isDateOnly: false };
}

function parseICSEvents(text) {
  const unfolded = unfoldICSLines(text);
  const events = [];
  let current = null;

  unfolded.forEach((line) => {
    if (line === "BEGIN:VEVENT") {
      current = {};
      return;
    }
    if (line === "END:VEVENT") {
      if (current?.DTSTART) {
        const start = parseICSTimestamp(current.DTSTART);
        const end = current.DTEND ? parseICSTimestamp(current.DTEND) : null;

        if (start) {
          let endDate = end?.date || new Date(start.date);
          if (
            end &&
            (start.isDateOnly || end.isDateOnly) &&
            end.date > start.date
          ) {
            endDate = new Date(end.date.getTime() - 24 * 60 * 60 * 1000);
          }

          const rawDescription =
            current.DESCRIPTION || current["X-ALT-DESC"] || "";
          const decodedDescription = unescapeICSText(rawDescription);
          const plainDescription =
            current["X-ALT-DESC"] && !current.DESCRIPTION
              ? stripHtml(decodedDescription)
              : decodedDescription;

          events.push({
            summary: unescapeICSText(current.SUMMARY || "Holiday"),
            description: plainDescription,
            start: start.date,
            end: endDate,
          });
        }
      }
      current = null;
      return;
    }

    if (!current) return;

    const [keyPart, ...valueParts] = line.split(":");
    if (!valueParts.length) return;
    const prop = keyPart.split(";")[0];
    current[prop] = valueParts.join(":");
  });

  return events;
}

async function fetchIcsTasks(cal, { fresh = false } = {}) {
  if (!cal?.url) return [];

  try {
    const url = fresh ? `${cal.url}?nocache=1` : cal.url;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(
        `${cal.label} calendar error: ${res.status} ${res.statusText}`
      );
    }
    const text = await res.text();
    const events = parseICSEvents(text);

    return events
      .filter((evt) => evt.start && evt.end)
      .sort((a, b) => a.start - b.start)
      .map((evt, idx) => ({
        id: `${cal.key}-${idx}-${evt.start.toISOString()}`,
        name: evt.summary,
        start: evt.start,
        end: evt.end,
        progress: 0,
        custom_class: `${cal.key}-task`,
        dependencies: "",
        _color: cal.color || LABEL_COLOURS.Default || "#5e6c84",
        _shortUrl: null,
        _company: cal.label,
        _calendarKey: cal.key,
        _summary: evt.summary,
        _details: evt.description || evt.summary || "",
        _debug: false,
      }));
  } catch (err) {
    console.warn(`Failed to load ${cal.label} ICS:`, err);
    return [];
  }
}

// =======================
// TRELLO FETCH
// =======================

async function fetchAllBoardsMeta() {
  if (!TRELLO_KEY || !TRELLO_TOKEN) {
    console.warn("Missing Trello credentials; cannot fetch board list.");
    return [];
  }

  const url =
    `https://api.trello.com/1/members/me/boards` +
    `?key=${encodeURIComponent(TRELLO_KEY)}` +
    `&token=${encodeURIComponent(TRELLO_TOKEN)}` +
    `&fields=name,id,closed,url`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Trello boards error: ${res.status} ${res.statusText}`);
    }
    const boards = await res.json();
    allBoardsMeta = boards;
    return boards;
  } catch (err) {
    console.warn("Failed to fetch boards:", err);
    return [];
  }
}

async function fetchPhasesForProjects(cards) {
  if (!allBoardsMeta.length) {
    await fetchAllBoardsMeta();
  }
  const projectLookup = {};
  cards.forEach((card) => {
    const norm = normalizeProjectName(card.name);
    if (!norm) return;
    projectLookup[norm.toLowerCase()] = {
      projectId: card.id,
      company: inferCompanyFromLabels(card.labels),
    };
  });

  const boardMatches = allBoardsMeta
    .map((board) => {
      const normBoard = normalizeProjectName(board.name).toLowerCase();
      const match = projectLookup[normBoard];
      if (!match) return null;
      return { board, project: match };
    })
    .filter(Boolean);

  const phaseResults = await Promise.all(
    boardMatches.map(({ board, project }) =>
      fetchBoardPhases(board, project.projectId, project.company)
    )
  );

  const map = {};
  phaseResults.forEach((item) => {
    if (!item) return;
    map[item.projectId] = item.phases;
  });
  phasesByProjectId = map;
  return map;
}

async function fetchBoardPhases(boardMeta, projectId, projectCompany) {
  if (!boardMeta?.id) return null;

  try {
    const listsRes = await fetch(
      `https://api.trello.com/1/boards/${boardMeta.id}/lists` +
        `?key=${encodeURIComponent(TRELLO_KEY)}` +
        `&token=${encodeURIComponent(TRELLO_TOKEN)}` +
        `&fields=name`
    );
    if (!listsRes.ok) {
      throw new Error(
        `Trello list error for board ${boardMeta.id}: ${listsRes.status} ${listsRes.statusText}`
      );
    }
    const lists = await listsRes.json();
    const phaseList = lists.find(
      (l) => l.name && l.name.trim().toLowerCase() === "phases"
    );
    if (!phaseList) return { projectId, phases: [] };

    const cardsRes = await fetch(
      `https://api.trello.com/1/lists/${phaseList.id}/cards` +
        `?key=${encodeURIComponent(TRELLO_KEY)}` +
        `&token=${encodeURIComponent(TRELLO_TOKEN)}` +
        `&fields=name,due,dueComplete,start,shortUrl,labels,idMembers`
    );
    if (!cardsRes.ok) {
      throw new Error(
        `Trello cards error for list ${phaseList.id}: ${cardsRes.status} ${cardsRes.statusText}`
      );
    }
    const cards = await cardsRes.json();

    const boardCompany = inferCompanyFromBoardName(boardMeta.name);
    const phases = cards
      .map((card, idx) => {
        const start = card.start ? new Date(card.start) : null;
        const due = card.due ? new Date(card.due) : null;
        if (!start || !due) return null;
        const color =
          LABEL_COLOURS[projectCompany] ||
          LABEL_COLOURS[boardCompany] ||
          LABEL_COLOURS.Default;
        return {
          id: card.id,
          name: card.name || "Phase",
          start,
          end: due,
          _shortUrl: card.shortUrl || null,
          _company: projectCompany || boardCompany || "Other",
          _color: color,
          _dueComplete: Boolean(card.dueComplete),
          _memberIds: card.idMembers || [],
        };
      })
      .filter(Boolean);
    return { projectId, phases };
  } catch (err) {
    console.warn("Failed to fetch phases:", err);
    return { projectId, phases: [] };
  }
}

async function fetchBoardCards(boardId, companyLabel) {
  if (!TRELLO_KEY || !TRELLO_TOKEN || !boardId) {
    throw new Error("Missing Trello credentials/boardId. Check config.js.");
  }

  const url =
    `https://api.trello.com/1/boards/${boardId}/cards` +
    `?key=${encodeURIComponent(TRELLO_KEY)}` +
    `&token=${encodeURIComponent(TRELLO_TOKEN)}` +
    `&fields=name,due,dueComplete,start,labels,shortUrl,idList,idMembers&customFieldItems=true`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Trello error for board ${boardId}: ${res.status} ${res.statusText}`
    );
  }

  const cards = await res.json();
  cards.forEach((card) => {

    if (companyLabel) {
      const hasLabel = (card.labels || []).some(
        (label) => label?.name?.toLowerCase() === companyLabel.toLowerCase()
      );
      if (!hasLabel) {
        card.labels = [
          ...(card.labels || []),
          { id: `auto-${companyLabel}`, name: companyLabel },
        ];
      }
    }
  });

  return cards;
}

async function fetchBoardMembers(boardId) {
  if (!TRELLO_KEY || !TRELLO_TOKEN || !boardId) return {};

  const url =
    `https://api.trello.com/1/boards/${boardId}/members` +
    `?key=${encodeURIComponent(TRELLO_KEY)}` +
    `&token=${encodeURIComponent(TRELLO_TOKEN)}` +
    `&fields=id,fullName,initials,avatarUrl`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(
        `Trello members error for board ${boardId}: ${res.status} ${res.statusText}`
      );
    }
    const members = await res.json();
    const map = {};
    members.forEach((m) => {
      if (m && m.id) map[m.id] = m;
    });
    return map;
  } catch (err) {
    console.warn("Failed to fetch members:", err);
    return {};
  }
}

async function fetchBoardLists(boardId, companyLabel) {
  if (!TRELLO_KEY || !TRELLO_TOKEN || !boardId) {
    throw new Error(
      "Missing Trello credentials/boardId when fetching lists. Check config.js."
    );
  }

  const url =
    `https://api.trello.com/1/boards/${boardId}/lists` +
    `?key=${encodeURIComponent(TRELLO_KEY)}` +
    `&token=${encodeURIComponent(TRELLO_TOKEN)}` +
    `&fields=name`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Trello list error for board ${boardId}: ${res.status} ${res.statusText}`
    );
  }

  const lists = await res.json();
  const map = {};
  lists.forEach((list) => {
    map[list.id] = { id: list.id, name: list.name, company: companyLabel };
  });
  return map;
}

async function fetchTrelloCards() {
  if (!TRELLO_KEY || !TRELLO_TOKEN || (!ME_BOARD_ID && !LRL_BOARD_ID)) {
    throw new Error(
      "Missing Trello configuration (key/token/board IDs). Check config.js."
    );
  }

  const boardFetches = [];
  const boardMeta = [];
  if (ME_BOARD_ID) {
    boardFetches.push(fetchBoardCards(ME_BOARD_ID, "ME"));
    boardMeta.push({ id: ME_BOARD_ID, label: "ME" });
  }
  if (LRL_BOARD_ID) {
    boardFetches.push(fetchBoardCards(LRL_BOARD_ID, "LRL"));
    boardMeta.push({ id: LRL_BOARD_ID, label: "LRL" });
  }

  const [cardResults, listResults, memberResults] = await Promise.all([
    Promise.all(boardFetches),
    Promise.all(
      boardMeta.map((meta) => fetchBoardLists(meta.id, meta.label))
    ),
    Promise.all(boardMeta.map((meta) => fetchBoardMembers(meta.id))),
  ]);
  allMembers = Object.assign({}, ...memberResults);
  buildMemberByCalendarKey();

  const cards = cardResults.flat();
  const listMeta = Object.assign({}, ...listResults);
  allListMeta = listMeta;

  return cards.map((card) => ({
    ...card,
    _listMeta: listMeta[card.idList] || null,
  }));
}

// =======================
// MAP CARDS → GANTT TASKS
// =======================

function darkenHexColor(hex, factor = 0.6) {
  if (typeof hex !== "string") return hex;
  const m = /^#?([a-f\d]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const num = parseInt(m[1], 16);
  const r = Math.max(0, Math.min(255, Math.round(((num >> 16) & 0xff) * factor)));
  const g = Math.max(0, Math.min(255, Math.round(((num >> 8) & 0xff) * factor)));
  const b = Math.max(0, Math.min(255, Math.round((num & 0xff) * factor)));
  const toHex = (n) => n.toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function isPhaseDone(phase, today) {
  if (phase._dueComplete) return true;
  const end = ensureDate(phase.end);
  return Boolean(end && end < today);
}

function computeProjectProgress(card, phases) {
  if (card.dueComplete) return 100;
  if (!phases || !phases.length) return 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const done = phases.reduce(
    (acc, phase) => acc + (isPhaseDone(phase, today) ? 1 : 0),
    0
  );
  return Math.round((done / phases.length) * 100);
}

function mapCardsToTasks(cards) {
  const tasks = [];

  cards.forEach((card) => {
    // 🔍 Convert Trello ISO strings → JS Date objects
    const start = card.start ? new Date(card.start) : null;
    const due = card.due ? new Date(card.due) : null;

    let startDate, endDate;

    if (start && due) {
      startDate = start;
      endDate = due;
    } else if (start && !due) {
      startDate = start;
      endDate = new Date(start.getTime());
      endDate.setDate(endDate.getDate() + 7); // fallback end
    } else if (!start && due) {
      endDate = due;
      startDate = new Date(due.getTime());
      startDate.setDate(startDate.getDate() - 7); // fallback start
    } else {
      // No usable dates → skip for Gantt (but still appear in sidebar)
      return;
    }

    // Label colouring
    const company = inferCompanyFromLabels(card.labels);
    const primaryLabel = card.labels && card.labels[0];
    const labelName = primaryLabel ? primaryLabel.name : null;

    const color =
      (labelName && LABEL_COLOURS[labelName]) ||
      LABEL_COLOURS[company] ||
      LABEL_COLOURS.Default;

    const progress = computeProjectProgress(card, phasesByProjectId[card.id]);

    // 🟧 FINAL TASK OBJECT (note: start & end MUST be Date objects)
    tasks.push({
      id: card.id,
      name: card.name,
      start: startDate,
      end: endDate,
      progress,
      custom_class: `task-${card.id}`,
      dependencies: "",
      _color: color,
      _shortUrl: card.shortUrl,
      _company: company,
      _dueComplete: Boolean(card.dueComplete),
      _memberIds: card.idMembers || [],
    });
  });

  return tasks;
}

// =======================
// SIDEBAR RENDERING
// =======================

function renderCompanyChips() {
  companyChipsEl.innerHTML = "";

  const companies = [
    { key: "ME", label: "ME", color: LABEL_COLOURS.ME },
    { key: "LRL", label: "LRL", color: LABEL_COLOURS.LRL },
    { key: "Other", label: "Other", color: "#cccccc" },
  ];

  companies.forEach((c) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    if (companyFilter[c.key]) chip.classList.add("active");

    const dot = document.createElement("span");
    dot.className = "chip-dot";
    dot.style.background = c.color;

    const text = document.createElement("span");
    text.textContent = c.label;

    chip.appendChild(dot);
    chip.appendChild(text);

    chip.addEventListener("click", () => {
      companyFilter[c.key] = !companyFilter[c.key];
      chip.classList.toggle("active", companyFilter[c.key]);
      syncStateToUrl();
      renderGanttFiltered();
    });

    companyChipsEl.appendChild(chip);
  });
}

function isDoneListName(listName) {
  return /^(done|complete|completed)$/i.test(String(listName || "").trim());
}

function getBoardUrlForCompany(company) {
  const boardIdByCompany = {
    ME: ME_BOARD_ID,
    LRL: LRL_BOARD_ID,
  };
  const boardId = boardIdByCompany[company];
  return boardId ? `https://trello.com/b/${boardId}` : null;
}

function openMissingDatesInTrello(company) {
  const boardUrl = getBoardUrlForCompany(company);
  if (!boardUrl) return;

  // Trello's board filter syntax handles cards with no due date.
  // This is not perfect for "missing start date", but it gets close enough
  // for the date cleanup pass and opens in the real Trello UI.
  window.open(`${boardUrl}?filter=due:none`, "_blank", "noopener");
}

function cardHasCalendarConflict(card, calendar) {
  if (!calendar.length) return false;

  const cardStart = ensureDate(card.start);
  const cardEnd = ensureDate(card.due);
  const cardMemberIds = card.idMembers || [];
  if (
    cardStart &&
    cardEnd &&
    findConflicts(cardStart, cardEnd, calendar, cardMemberIds).length
  ) {
    return true;
  }

  const phases = phasesByProjectId[card.id] || [];
  return phases.some((phase) => {
    const ps = ensureDate(phase.start);
    const pe = ensureDate(phase.end);
    const phaseMemberIds =
      phase._memberIds && phase._memberIds.length
        ? phase._memberIds
        : cardMemberIds;
    return (
      ps && pe && findConflicts(ps, pe, calendar, phaseMemberIds).length > 0
    );
  });
}

function getSidebarStatusCounts(lists) {
  const now = new Date();
  const calendar = getAllCalendarTasks();

  return Object.entries(lists).reduce(
    (counts, [listName, group]) => {
      const normalized = listName.toLowerCase();
      const count = group.cards.length;
      const isDoneList = isDoneListName(listName);

      if (
        normalized.includes("quote") ||
        normalized.includes("approval") ||
        normalized.includes("aproval")
      ) {
        counts.quote += count;
      }
      if (normalized === "live") {
        counts.live += count;
      }

      group.cards.forEach((card) => {
        if (!card.start && !card.due) {
          counts.missingDates += 1;
        }

        const due = ensureDate(card.due);
        if (due && due < now && !card.dueComplete && !isDoneList) {
          counts.overdue += 1;
        }

        if (!isDoneList && cardHasCalendarConflict(card, calendar)) {
          counts.conflicts += 1;
        }
      });

      return counts;
    },
    { quote: 0, live: 0, missingDates: 0, overdue: 0, conflicts: 0 }
  );
}

function renderSidebar(cards) {
  projectsListEl.innerHTML = "";
  activeProjectIds.clear();

  const nested = cards.reduce((acc, card) => {
    const company = inferCompanyFromLabels(card.labels);
    const listName = card._listMeta?.name || "Ungrouped";
    if (!acc[company]) acc[company] = {};
    if (!acc[company][listName]) {
      acc[company][listName] = {
        cards: [],
        position: card._listMeta?.pos ?? Number.MAX_SAFE_INTEGER,
      };
    }
    acc[company][listName].cards.push(card);
    return acc;
  }, {});

  const companyOrder = ["ME", "LRL", "Other"];

  companyOrder.forEach((company) => {
    const lists = nested[company];
    if (!lists) return;

    const section = document.createElement("div");
    section.className = "sidebar-tree-section";

    const header = document.createElement("div");
    header.className = "sidebar-tree-header";

    const title = document.createElement("span");
    title.className = "sidebar-tree-title";
    title.textContent = company;

    const counts = getSidebarStatusCounts(lists);
    const countsEl = document.createElement("span");
    countsEl.className = "sidebar-counts";
    countsEl.title =
      "Q = quote/approval, L = live, M = missing dates, O = overdue, ⚠ = clashes with holidays/family";
    countsEl.innerHTML = `
      <span class="sidebar-count-pill">Q:${counts.quote}</span>
      <span class="sidebar-count-pill">L:${counts.live}</span>
      <span class="sidebar-count-pill warning clickable" data-count-action="missing-dates">
        M:${counts.missingDates}
      </span>
      <span class="sidebar-count-pill danger">O:${counts.overdue}</span>
      <span class="sidebar-count-pill danger">⚠:${counts.conflicts}</span>
    `;

    countsEl
      .querySelector('[data-count-action="missing-dates"]')
      ?.addEventListener("click", (event) => {
        event.stopPropagation();
        openMissingDatesInTrello(company);
      });

    const icon = document.createElement("span");
    icon.className = "toggle-icon";
    header.appendChild(title);
    header.appendChild(countsEl);
    header.appendChild(icon);

    const listContainer = document.createElement("div");
    listContainer.className = "sidebar-tree-list";

    const applyCompanyCollapsed = (collapsed) => {
      listContainer.style.display = collapsed ? "none" : "block";
      icon.textContent = collapsed ? "+" : "−";
    };

    let companyCollapsed = Boolean(
      sidebarState.companyCollapsed?.[company]
    );
    applyCompanyCollapsed(companyCollapsed);

    header.addEventListener("click", () => {
      companyCollapsed = !companyCollapsed;
      sidebarState.companyCollapsed[company] = companyCollapsed;
      applyCompanyCollapsed(companyCollapsed);
      saveSidebarState();
    });

    const listNames = Object.keys(lists).sort((a, b) => {
      const posA = lists[a].position;
      const posB = lists[b].position;
      if (posA !== posB) return posA - posB;
      return a.localeCompare(b);
    });
    listNames.forEach((listName) => {
      const listWrapper = document.createElement("div");
      listWrapper.className = "sidebar-list-wrapper";

      const listHeader = document.createElement("div");
      listHeader.className = "sidebar-list-header";
      listHeader.textContent = listName;

      const listIcon = document.createElement("span");
      listIcon.className = "toggle-icon";
      listHeader.appendChild(listIcon);

      const cardsContainer = document.createElement("div");
      cardsContainer.className = "sidebar-list-cards";

      const listKey = `${company}::${listName}`;
      const applyListCollapsed = (collapsed) => {
        cardsContainer.style.display = collapsed ? "none" : "block";
        listIcon.textContent = collapsed ? "+" : "−";
      };
      let listCollapsed = Boolean(
        sidebarState.listCollapsed?.[listKey]
      );
      applyListCollapsed(listCollapsed);

      listHeader.addEventListener("click", () => {
        listCollapsed = !listCollapsed;
        sidebarState.listCollapsed[listKey] = listCollapsed;
        applyListCollapsed(listCollapsed);
        saveSidebarState();
      });

      lists[listName].cards
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach((card) => {
          const wrapper = document.createElement("div");
          wrapper.className = "project-row";
          wrapper.dataset.cardName = (card.name || "").toLowerCase();

          const row = document.createElement("label");
          row.className = "project-toggle";

          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          const isHidden = hiddenProjectIds.has(card.id);
          checkbox.checked = !isHidden;
          checkbox.dataset.cardId = card.id;
          if (!isHidden) activeProjectIds.add(card.id);

          checkbox.addEventListener("change", () => {
            if (checkbox.checked) {
              activeProjectIds.add(card.id);
              hiddenProjectIds.delete(card.id);
            } else {
              activeProjectIds.delete(card.id);
              hiddenProjectIds.add(card.id);
            }
            syncStateToUrl();
            renderGanttFiltered();
          });

          const span = document.createElement("span");
          span.textContent = card.name;

          const dateButton = document.createElement("button");
          dateButton.type = "button";
          dateButton.className = "card-action-btn";
          if (!card.start || !card.due) {
            dateButton.classList.add("needs-dates");
          }
          dateButton.textContent = "📅";
          dateButton.title = card.start || card.due ? "Edit dates" : "Add dates";

          const doneButton = document.createElement("button");
          doneButton.type = "button";
          doneButton.className = "card-action-btn";
          doneButton.textContent = "✅";
          doneButton.title = "Move to Done";
          if (isDoneListName(card._listMeta?.name)) {
            doneButton.disabled = true;
            doneButton.title = "Already in Done";
          }

          const editor = document.createElement("div");
          editor.className = "card-date-editor";

          const startInput = document.createElement("input");
          startInput.type = "date";
          startInput.value = formatDateForDisplay(card.start || card.due);
          startInput.title = "Start date";

          const endInput = document.createElement("input");
          endInput.type = "date";
          endInput.value = formatDateForDisplay(card.due || card.start);
          endInput.title = "End/due date";

          const saveButton = document.createElement("button");
          saveButton.type = "button";
          saveButton.textContent = "Save";

          const cancelButton = document.createElement("button");
          cancelButton.type = "button";
          cancelButton.textContent = "Cancel";

          dateButton.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            editor.classList.toggle("open");
          });

          doneButton.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            moveCardToDone(card);
          });

          saveButton.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            saveCardDateInputs(card, startInput, endInput);
          });

          cancelButton.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            editor.classList.remove("open");
          });

          row.appendChild(checkbox);
          row.appendChild(span);
          row.appendChild(dateButton);
          row.appendChild(doneButton);
          editor.appendChild(startInput);
          editor.appendChild(endInput);
          editor.appendChild(saveButton);
          editor.appendChild(cancelButton);
          wrapper.appendChild(row);
          wrapper.appendChild(editor);
          cardsContainer.appendChild(wrapper);
        });

      listWrapper.appendChild(listHeader);
      listWrapper.appendChild(cardsContainer);
      listContainer.appendChild(listWrapper);
    });

    section.appendChild(header);
    section.appendChild(listContainer);
    projectsListEl.appendChild(section);
  });

  if (projectSearchQuery) applySidebarSearch(projectSearchQuery);
}

function applySidebarSearch(query) {
  const q = (query || "").trim().toLowerCase();
  const isSearching = Boolean(q);

  projectsListEl
    .querySelectorAll(".project-row[data-card-name]")
    .forEach((row) => {
      const name = row.dataset.cardName || "";
      row.style.display = !isSearching || name.includes(q) ? "" : "none";
    });

  projectsListEl.querySelectorAll(".sidebar-list-wrapper").forEach((wrapper) => {
    const rows = wrapper.querySelectorAll(".project-row");
    const hasVisible = Array.from(rows).some(
      (r) => r.style.display !== "none"
    );
    wrapper.style.display = isSearching && !hasVisible ? "none" : "";

    const cardsContainer = wrapper.querySelector(".sidebar-list-cards");
    if (cardsContainer && isSearching && hasVisible) {
      cardsContainer.style.display = "block";
    }
  });

  projectsListEl.querySelectorAll(".sidebar-tree-section").forEach((section) => {
    const wrappers = section.querySelectorAll(".sidebar-list-wrapper");
    const hasVisible = Array.from(wrappers).some(
      (w) => w.style.display !== "none"
    );
    section.style.display = isSearching && !hasVisible ? "none" : "";

    const listContainer = section.querySelector(".sidebar-tree-list");
    if (listContainer && isSearching && hasVisible) {
      listContainer.style.display = "block";
    }
  });
}

if (projectSearchEl) {
  projectSearchEl.addEventListener("input", () => {
    const previous = projectSearchQuery;
    projectSearchQuery = projectSearchEl.value.trim().toLowerCase();
    if (!projectSearchQuery && previous) {
      // Cleared — re-render to restore collapse state from sidebarState.
      renderSidebar(allCards);
    } else {
      applySidebarSearch(projectSearchQuery);
    }
  });
  projectSearchEl.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && projectSearchEl.value) {
      projectSearchEl.value = "";
      projectSearchEl.dispatchEvent(new Event("input"));
    }
  });
}

function applyCalendarsCollapsed(collapsed) {
  if (calendarListEl) calendarListEl.style.display = collapsed ? "none" : "block";
  if (calendarsToggleIconEl) calendarsToggleIconEl.textContent = collapsed ? "+" : "−";
}

function setupCalendarsCollapse() {
  if (!calendarsHeaderEl) return;
  applyCalendarsCollapsed(sidebarState.calendarsCollapsed);
  calendarsHeaderEl.addEventListener("click", () => {
    sidebarState.calendarsCollapsed = !sidebarState.calendarsCollapsed;
    applyCalendarsCollapsed(sidebarState.calendarsCollapsed);
    saveSidebarState();
  });
}

function renderCalendarList() {
  if (!calendarListEl) return;
  calendarListEl.innerHTML = "";
  if (!CALENDARS.length) return;

  CALENDARS.forEach((cal) => {
    const row = document.createElement("label");
    row.className = "calendar-row";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = enabledCalendarKeys.has(cal.key);
    checkbox.dataset.calKey = cal.key;
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        enabledCalendarKeys.add(cal.key);
      } else {
        enabledCalendarKeys.delete(cal.key);
      }
      syncStateToUrl();
      renderGanttFiltered();
    });

    const dot = document.createElement("span");
    dot.className = "calendar-dot";
    dot.style.background = cal.color || LABEL_COLOURS.Default;

    const label = document.createElement("span");
    label.className = "calendar-label";
    label.textContent = cal.label || cal.key;

    row.appendChild(checkbox);
    row.appendChild(dot);
    row.appendChild(label);
    calendarListEl.appendChild(row);
  });
}

document.querySelectorAll("[data-range-preset]").forEach((button) => {
  button.addEventListener("click", () => {
    setRangePreset(button.dataset.rangePreset);
  });
});

if (rangeNavigatorEl && rangeWindowEl) {
  rangeNavigatorEl.addEventListener("pointerdown", (event) => {
    const rect = rangeNavigatorEl.getBoundingClientRect();
    const target = event.target;
    const isLeftHandle = target.classList.contains("left");
    const isRightHandle = target.classList.contains("right");
    const mode = isLeftHandle ? "start" : isRightHandle ? "end" : "move";
    rangeDragState = {
      mode,
      rect,
      start: new Date(rangeStart),
      end: new Date(rangeEnd),
      pointerStart: event.clientX,
    };
    rangeNavigatorEl.setPointerCapture(event.pointerId);
  });

  rangeNavigatorEl.addEventListener("pointermove", (event) => {
    if (!rangeDragState || !navigatorDomainStart || !navigatorDomainEnd) return;

    const percent =
      ((event.clientX - rangeDragState.rect.left) / rangeDragState.rect.width) *
      100;
    const dateAtPointer = navigatorPercentToDate(percent);
    let nextStart = new Date(rangeStart);
    let nextEnd = new Date(rangeEnd);

    if (rangeDragState.mode === "start") {
      nextStart = dateAtPointer;
    } else if (rangeDragState.mode === "end") {
      nextEnd = dateAtPointer;
    } else {
      const delta = event.clientX - rangeDragState.pointerStart;
      const domainMs = navigatorDomainEnd - navigatorDomainStart;
      const deltaMs = (delta / rangeDragState.rect.width) * domainMs;
      nextStart = new Date(rangeDragState.start.getTime() + deltaMs);
      nextEnd = new Date(rangeDragState.end.getTime() + deltaMs);
    }

    if (nextEnd - nextStart < DAY_MS) return;
    setGanttRange(nextStart, nextEnd, false);
  });

  rangeNavigatorEl.addEventListener("pointerup", (event) => {
    if (!rangeDragState) return;
    rangeDragState = null;
    rangeNavigatorEl.releasePointerCapture(event.pointerId);
    renderGanttFiltered();
  });
}

if (rangeStartEl && rangeEndEl) {
  rangeStartEl.addEventListener("change", () => {
    const start = parseDateInput(rangeStartEl.value);
    const end = parseDateInput(rangeEndEl.value);
    setGanttRange(start, end);
  });
  rangeEndEl.addEventListener("change", () => {
    const start = parseDateInput(rangeStartEl.value);
    const end = parseDateInput(rangeEndEl.value);
    setGanttRange(start, end);
  });
}


// =======================
// GANTT RENDERING
// =======================

function renderGanttFiltered() {
  const tasksToShow = allTasks.filter((task) => {
    if (!activeProjectIds.has(task.id)) return false;
    if (!companyFilter[task._company]) return false;
    return true;
  });

  if (!rangeStart || !rangeEnd) {
    const defaultRange = getDefaultRange();
    rangeStart = defaultRange.start;
    rangeEnd = defaultRange.end;
    syncRangeInputs();
  }
  renderRangeNavigator();

  const windowStart = new Date(rangeStart);
  const windowEnd = new Date(rangeEnd);

  const taskWithinWindow = (task) => {
    const startDate =
      task.start instanceof Date ? task.start : new Date(task.start);
    const endDate = task.end instanceof Date ? task.end : new Date(task.end);
    return endDate >= windowStart && startDate <= windowEnd;
  };

  const windowedProjects = tasksToShow.filter(taskWithinWindow);

  const companyOrderRank = { ME: 1, LRL: 2, Other: 3 };
  const sortedProjects = windowedProjects.sort((a, b) => {
    const rankA = companyOrderRank[a._company] || 99;
    const rankB = companyOrderRank[b._company] || 99;
    if (rankA !== rankB) return rankA - rankB;
    const nameA = (a.name || "").toLowerCase();
    const nameB = (b.name || "").toLowerCase();
    if (nameA !== nameB) return nameA.localeCompare(nameB);
    const startA = ensureDate(a.start) || new Date(0);
    const startB = ensureDate(b.start) || new Date(0);
    return startA - startB;
  });

  const projectTasks = [...sortedProjects];

  const calendarSegmentsByKey = {};
  const conflictCalendar = [];

  CALENDARS.forEach((cal) => {
    if (!isCalendarEnabled(cal.key)) return;
    const tasks = (calendarTasksByKey[cal.key] || []).filter(taskWithinWindow);
    conflictCalendar.push(...tasks);
    calendarSegmentsByKey[cal.key] = tasks
      .map((task, idx) => {
        const start = ensureDate(task.start);
        const end = ensureDate(task.end);
        if (!start || !end) return null;
        const startStr = formatDateForTask(start);
        const endStr = formatDateForTask(end);
        if (!startStr || !endStr) return null;
        return {
          id: task.id || `${cal.key}-${idx}`,
          start_date: startStr,
          end_date: endStr,
          duration: daysBetween(start, end),
          name: task.name,
          _shortUrl: task._shortUrl,
          _company: task._company || cal.label,
          _startDate: start,
          _endDate: end,
          _summary: task._summary,
          _details: task._details,
          _color: task._color || cal.color,
          _calendarKey: cal.key,
        };
      })
      .filter(Boolean);
  });

  const totalCalendarSegments = Object.values(calendarSegmentsByKey).reduce(
    (sum, arr) => sum + arr.length,
    0
  );

  if (!projectTasks.length && !totalCalendarSegments) {
    if (ganttInitialized && window.gantt?.clearAll) {
      gantt.clearAll();
    }
    summaryEl.textContent = "";
    showEmptyState(
      "No tasks in the current date window. Adjust filters or try again later."
    );
    return;
  }

  const normalizedProjects = projectTasks
    .map((task) => {
      const start = ensureDate(task.start);
      const end = ensureDate(task.end);
      if (!start || !end) return null;
      return {
        ...task,
        start,
        end,
      };
    })
    .filter(Boolean);

  if (!normalizedProjects.length && !totalCalendarSegments) {
    summaryEl.textContent = "";
    showEmptyState(
      "No renderable tasks (missing dates). Adjust filters or try again later."
    );
    if (ganttInitialized && window.gantt?.clearAll) {
      gantt.clearAll();
    }
    return;
  }

  hideEmptyState();

  const ready = setupDHTMLXGantt();
  if (!ready) {
    ganttContainer.textContent =
      "dhtmlxGantt failed to load. Check your network connection.";
    summaryEl.textContent = "";
    return;
  }

  const ganttProjectTasks = normalizedProjects
    .map((task) => {
      const startStr = formatDateForTask(task.start);
      const endStr = formatDateForTask(task.end);
      if (!startStr || !endStr) return null;
      const safeProgress = Math.max(
        0,
        Math.min(1, (task.progress || 0) / 100)
      );
      return {
        id: task.id,
        text: task.name,
        start_date: startStr,
        end_date: endStr,
        progress: safeProgress,
        color: task._color,
        progressColor: task._color,
        _shortUrl: task._shortUrl,
        _company: task._company,
        _memberIds: task._memberIds || [],
        _dueComplete: task._dueComplete,
        _conflicts: findConflicts(
          task.start,
          task.end,
          conflictCalendar,
          task._memberIds || []
        ),
      };
    })
    .filter(Boolean);

  const dataset = [];
  const projectHierarchyNodes = [];

  const appendLane = (segments, laneId, laneLabel, parentId) => {
    const earliest = segments.length
      ? segments.reduce((min, seg) => {
          const segDate = ensureDate(seg.start_date);
          if (!segDate) return min;
          return segDate < min ? segDate : min;
        }, new Date(windowStart))
      : new Date(windowStart);

    const latest = segments.length
      ? segments.reduce((max, seg) => {
          const segDate = ensureDate(seg.end_date);
          if (!segDate) return max;
          return segDate > max ? segDate : max;
        }, new Date(windowEnd))
      : new Date(windowEnd);

    const laneSegments = segments.map((segment, idx) => ({
      id: `${segment.id}-${idx}`,
      start_date: segment.start_date,
      duration: segment.duration,
      name: segment.name,
      _shortUrl: segment._shortUrl,
      _company: segment._company || laneLabel,
      _startDate: segment._startDate,
      _endDate: segment._endDate,
      _summary: segment._summary,
      _details: segment._details,
      _color: segment._color,
      css: "holiday-segment",
      _laneType: laneLabel,
    }));

    const laneTask = {
      id: laneId,
      text: laneLabel,
      start_date: formatDateForTask(earliest),
      duration: Math.max(1, daysBetween(earliest, latest)),
      progress: 0,
      render: "split",
      color: "transparent",
      progressColor: "transparent",
      _isHolidayLane: true,
      segments: laneSegments,
      _segments: laneSegments,
      _laneType: laneLabel,
      parent: parentId || 0,
    };

    dataset.push(laneTask);
  };

  const calendarGroupHeaderId = "calendar-group";
  const enabledCalendars = CALENDARS.filter((c) => isCalendarEnabled(c.key));
  if (enabledCalendars.length) {
    dataset.push({
      id: calendarGroupHeaderId,
      text: "Calendars",
      start_date: formatDateForTask(windowStart),
      duration: Math.max(1, daysBetween(windowStart, windowEnd)),
      progress: 0,
      open: taskOpenState[calendarGroupHeaderId] ?? true,
      parent: 0,
      color: "transparent",
      progressColor: "transparent",
      _isCalendarGroup: true,
    });
    enabledCalendars.forEach((cal) => {
      appendLane(
        calendarSegmentsByKey[cal.key] || [],
        `${cal.key}-lane`,
        cal.label,
        calendarGroupHeaderId
      );
    });
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const companyGroupId = (company) => `company-${company || "Other"}`;
  const companyTotals = {};

  ganttProjectTasks.forEach((task) => {
    const parentId = `${task.id}-group`;
    const baseStartDate = ensureDate(task.start_date);
    const baseEndDate = ensureDate(task.end_date);
    const companyKey = task._company || "Other";
    const companyParentId = companyGroupId(companyKey);

    const totals = companyTotals[companyKey] || {
      earliest: null,
      latest: null,
    };
    if (baseStartDate && (!totals.earliest || baseStartDate < totals.earliest)) {
      totals.earliest = baseStartDate;
    }
    if (baseEndDate && (!totals.latest || baseEndDate > totals.latest)) {
      totals.latest = baseEndDate;
    }
    companyTotals[companyKey] = totals;

    projectHierarchyNodes.push({
      id: parentId,
      text: task.text,
      start_date: task.start_date,
      end_date: task.end_date,
      progress: task.progress,
      open: taskOpenState[parentId] ?? false,
      parent: companyParentId,
      _company: task._company,
      _shortUrl: task._shortUrl,
      color: task.color,
      progressColor: darkenHexColor(task.color, 0.55),
      _cardId: task.id,
      _memberIds: task._memberIds || [],
      _dueComplete: task._dueComplete,
      _conflicts: task._conflicts || [],
    });

    const phaseTasks = phasesByProjectId[task.id] || [];
    phaseTasks.forEach((phase) => {
      const phaseStart = ensureDate(phase.start);
      const phaseEnd = ensureDate(phase.end);
      if (!phaseStart || !phaseEnd) return;
      const phaseStartStr = formatDateForTask(phaseStart);
      const phaseEndStr = formatDateForTask(phaseEnd);
      if (!phaseStartStr || !phaseEndStr) return;
      const phaseProgress = isPhaseDone(phase, today) ? 1 : 0;
      projectHierarchyNodes.push({
        id: phase.id,
        text: phase.name,
        start_date: phaseStartStr,
        end_date: phaseEndStr,
        progress: phaseProgress,
        parent: parentId,
        color: phase._color,
        progressColor: darkenHexColor(phase._color, 0.55),
        _company: phase._company,
        _shortUrl: phase._shortUrl,
        _cardId: phase.id,
        _dueComplete: phase._dueComplete,
        _memberIds: phase._memberIds || [],
        _conflicts: findConflicts(
          phaseStart,
          phaseEnd,
          conflictCalendar,
          (phase._memberIds && phase._memberIds.length
            ? phase._memberIds
            : task._memberIds) || []
        ),
      });
    });
  });

  const companyOrderForHeaders = ["ME", "LRL", "Other"];
  const companyHeaders = [];
  companyOrderForHeaders.forEach((company) => {
    const totals = companyTotals[company];
    if (!totals || !totals.earliest || !totals.latest) return;
    const headerId = companyGroupId(company);
    companyHeaders.push({
      id: headerId,
      text: company,
      start_date: formatDateForTask(totals.earliest),
      end_date: formatDateForTask(totals.latest),
      progress: 0,
      open: taskOpenState[headerId] ?? true,
      parent: 0,
      color: "transparent",
      progressColor: "transparent",
      _isCompanyGroup: true,
      _company: company,
    });
  });

  dataset.push(...companyHeaders, ...projectHierarchyNodes);

  if (!dataset.length) {
    summaryEl.textContent = "";
    showEmptyState("Unable to render tasks due to invalid dates.");
    if (ganttInitialized && window.gantt?.clearAll) {
      gantt.clearAll();
    }
    return;
  }

  gantt.config.start_date = new Date(windowStart);
  gantt.config.end_date = new Date(windowEnd);
  gantt.clearAll();
  gantt.parse({ data: dataset, links: [] });
  if (gantt.addMarker) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    gantt.addMarker({
      start_date: today,
      css: "today-marker",
      text: "Today",
      title: "Today",
    });
  }
  renderTodayLineOverlay();

  const dateFmt = (date) => date.toISOString().substring(0, 10);
  const projectCount = windowedProjects.length;
  summaryEl.textContent = `${projectCount} project(s) + ${totalCalendarSegments} calendar item(s) from ${dateFmt(
    windowStart
  )} to ${dateFmt(windowEnd)}`;
}

// =======================
// MAIN FLOW
// =======================

async function loadFromTrello({ fresh = false } = {}) {
  const hasCachedData = allCards.length > 0;
  setStatus(hasCachedData ? "Refreshing from Trello…" : "Loading from Trello…");
  refreshBtn.disabled = true;

  try {
    const boardsPromise = fetchAllBoardsMeta();

    const [cards, ...calendarResults] = await Promise.all([
      fetchTrelloCards(),
      ...CALENDARS.map((cal) => fetchIcsTasks(cal, { fresh })),
    ]);
    await boardsPromise;
    await fetchPhasesForProjects(cards);
    allCards = cards;
    allTasks = mapCardsToTasks(cards);
    calendarTasksByKey = Object.fromEntries(
      CALENDARS.map((cal, i) => [cal.key, calendarResults[i] || []])
    );

    renderCompanyChips();
    renderSidebar(cards);
    const calSummary = CALENDARS.map(
      (cal) => `${(calendarTasksByKey[cal.key] || []).length} ${cal.label}`
    ).join(", ");
    setStatus(
      `Loaded ${cards.length} card(s) (${allTasks.length} with dates)${
        calSummary ? `; calendars: ${calSummary}` : ""
      }.`
    );
    renderGanttFiltered();
    saveDataCache();
  } catch (err) {
    console.error(err);
    if (hasCachedData) {
      setStatus(`Refresh failed (${err.message}). Showing cached data.`);
    } else {
      setStatus(`Error: ${err.message}`);
      ganttContainer.textContent = "Failed to load data from Trello.";
    }
  } finally {
    refreshBtn.disabled = false;
  }
}

// Wire refresh
refreshBtn.addEventListener("click", () => {
  loadFromTrello({ fresh: true });
});

async function pullFromGit() {
  setStatus("Pulling latest from git…");
  pullBtn.disabled = true;
  try {
    const res = await fetch("/admin/pull", { method: "POST" });
    const data = await res.json();
    if (!data.ok) {
      let msg = data.message || `HTTP ${res.status}`;
      if (Array.isArray(data.dirty_files) && data.dirty_files.length) {
        const preview = data.dirty_files.slice(0, 5).join(", ");
        const extra =
          data.dirty_files.length > 5
            ? `, +${data.dirty_files.length - 5} more`
            : "";
        msg += ` Dirty: ${preview}${extra}`;
      }
      setStatus(`Pull failed: ${msg}`);
      return;
    }
    if (!data.changed_files || data.changed_files.length === 0) {
      setStatus(data.message || "Already up to date.");
      return;
    }
    const serverNote = data.server_changed
      ? " dev-server.py changed — restart the server too."
      : "";
    setStatus(`${data.message}${serverNote}`);
    const ask = `Pulled ${data.changed_files.length} file(s). Reload the page now?${
      serverNote ? "\n\n" + serverNote.trim() : ""
    }`;
    if (window.confirm(ask)) {
      window.location.reload();
    }
  } catch (err) {
    setStatus(`Pull failed: ${err.message}`);
  } finally {
    pullBtn.disabled = false;
  }
}

pullBtn.addEventListener("click", pullFromGit);

// Initial load
document.addEventListener("DOMContentLoaded", () => {
  if (!TRELLO_KEY || !TRELLO_TOKEN || (!ME_BOARD_ID && !LRL_BOARD_ID)) {
    setStatus(
      "Configure trelloKey/trelloToken and board IDs (ME_BoardId/LRL_BoardId) in config.js."
    );
    return;
  }

  applyUrlState();
  renderCalendarList();
  setupCalendarsCollapse();

  const cached = loadDataCache();
  if (cached && cached.cards.length) {
    try {
      hydrateFromCache(cached);
      setStatus(
        `Showing cached data from ${formatRelativeAge(cached.savedAt)} · refreshing…`
      );
    } catch (err) {
      console.warn("Failed to hydrate from cache:", err);
    }
  }

  loadFromTrello();
});
