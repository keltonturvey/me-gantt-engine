// main.js

// =======================
// CONFIG BRIDGE
// =======================

if (!window.ME_GANTT_CONFIG) {
  console.error("ME_GANTT_CONFIG not found. Did you create config.js?");
}

console.log("Is dhtmlxGantt loaded?", typeof window.gantt);

const TRELLO_KEY = window.ME_GANTT_CONFIG?.trelloKey || "";
const TRELLO_TOKEN = window.ME_GANTT_CONFIG?.trelloToken || "";
const ME_BOARD_ID =
  window.ME_GANTT_CONFIG?.portfolioBoardId ||
  window.ME_GANTT_CONFIG?.ME_BoardId ||
  "";
const LRL_BOARD_ID = window.ME_GANTT_CONFIG?.LRL_BoardId || "";
const HOLIDAY_ICS_URL = window.ME_GANTT_CONFIG?.holidayICS || "";
const FAMILY_ICS_URL = window.ME_GANTT_CONFIG?.familyICS || "";
const DAY_MS = 24 * 60 * 60 * 1000;
const SIDEBAR_STATE_KEY = "meGanttTreeState";
const TASK_OPEN_STATE_KEY = "meGanttOpenState";

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
const ganttContainer = document.getElementById("gantt-container");
const companyChipsEl = document.getElementById("company-chips");
const holidayToggleEl = document.getElementById("toggle-holidays");
const debugToggleEl = document.getElementById("toggle-debug-data");
const holidayDebugToggleEl = document.getElementById("toggle-holiday-debug");

let ganttInitialized = false;
let holidayLayerId = null;
let holidayTooltipEl = null;
let sidebarState = loadSidebarState();
let taskOpenState = loadTaskOpenState();
let allCards = [];
let allTasks = [];
let holidayTasks = [];
let familyTasks = [];
let allBoardsMeta = [];
let phasesByProjectId = {};
let activeProjectIds = new Set();
let companyFilter = {
  ME: true,
  LRL: true,
  Other: true,
};
let includeHolidays = holidayToggleEl ? holidayToggleEl.checked : true;
let useDebugData = debugToggleEl ? debugToggleEl.checked : false;
let useDebugHoliday = holidayDebugToggleEl ? holidayDebugToggleEl.checked : false;
let includeFamily = includeHolidays;

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

function loadSidebarState() {
  try {
    const raw = localStorage.getItem(SIDEBAR_STATE_KEY);
    if (!raw) {
      return { companyCollapsed: {}, listCollapsed: {} };
    }
    const parsed = JSON.parse(raw);
    return {
      companyCollapsed: parsed.companyCollapsed || {},
      listCollapsed: parsed.listCollapsed || {},
    };
  } catch (err) {
    console.warn("Failed to load sidebar state:", err);
    return { companyCollapsed: {}, listCollapsed: {} };
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

async function updateTrelloCardDates(cardId, startDate, endDate) {
  if (!cardId || !startDate || !endDate) return;
  if (!TRELLO_KEY || !TRELLO_TOKEN) return;

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
  } catch (err) {
    console.warn("Failed to update Trello card dates:", err);
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
  gantt.config.show_markers = false;
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
      template: (task) => `<span class="gantt-grid-label">${task.text}</span>`,
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

    return `
      <div class="details-container">
        <h5>${escapeHtml(task.text)}</h5>
        <p>${escapeHtml(formatDateForDisplay(start))} → ${escapeHtml(
      formatDateForDisplay(end)
    )}</p>
        <p>Company: ${escapeHtml(task._company || "Unknown")}</p>
        ${url}
      </div>
    `;
  };

  gantt.templates.task_class = (_start, _end, task) => {
    const classes = [];
    if (task._company === "Holiday") classes.push("holiday-task");
    if (task._company === "Debug") classes.push("debug-task");
    if (task._isHolidayLane) classes.push("holiday-lane");
    if (task.id === "family-lane" || task._laneType === "Family")
      classes.push("family-lane");
    return classes.join(" ");
  };

  gantt.init("gantt");
  ensureHolidayTaskLayer();
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
  if (task.id === "holiday-lane" || task.id === "family-lane") return false;
  if (task._company === "Holiday" || task._company === "Family") return false;
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

async function fetchHolidayTasks() {
  if (!HOLIDAY_ICS_URL) return [];

  try {
    const res = await fetch(HOLIDAY_ICS_URL);
    if (!res.ok) {
      throw new Error(
        `Holiday calendar error: ${res.status} ${res.statusText}`
      );
    }
    const text = await res.text();
    const events = parseICSEvents(text);

    const mapped = events
      .filter((evt) => evt.start && evt.end)
      .sort((a, b) => a.start - b.start)
      .map((evt, idx) => ({
        id: `holiday-${idx}-${evt.start.toISOString()}`,
        name: evt.summary,
        start: evt.start,
        end: evt.end,
        progress: 0,
        custom_class: "holiday-task",
        dependencies: "",
        _color: LABEL_COLOURS.Holiday || "#ff5630",
        _shortUrl: null,
        _company: "Holiday",
        _summary: evt.summary,
        _details: evt.description || evt.summary || "",
        _debug: false,
      }));

    console.log(`Loaded ${mapped.length} holiday event(s) from ICS`);
    return mapped;
  } catch (err) {
    console.warn("Failed to load holiday ICS:", err);
    return [];
  }
}

async function fetchFamilyTasks() {
  const url = FAMILY_ICS_URL || HOLIDAY_ICS_URL;
  if (!url) return [];

  try {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(
        `Family calendar error: ${res.status} ${res.statusText}`
      );
    }
    const text = await res.text();
    const events = parseICSEvents(text);

    const mapped = events
      .filter((evt) => evt.start && evt.end)
      .sort((a, b) => a.start - b.start)
      .map((evt, idx) => ({
        id: `family-${idx}-${evt.start.toISOString()}`,
        name: evt.summary,
        start: evt.start,
        end: evt.end,
        progress: 0,
        custom_class: "family-task",
        dependencies: "",
        _color: LABEL_COLOURS.Family || "#36b37e",
        _shortUrl: null,
        _company: "Family",
        _summary: evt.summary,
        _details: evt.description || evt.summary || "",
        _debug: false,
      }));

    console.log(`Loaded ${mapped.length} family event(s) from ICS`);
    return mapped;
  } catch (err) {
    console.warn("Failed to load family ICS:", err);
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
    console.log(
      `Fetched ${boards.length} board(s):`,
      boards.map((b) => ({ id: b.id, name: b.name, closed: b.closed }))
    );
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
        `&fields=name,due,start,shortUrl,labels`
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
        };
      })
      .filter(Boolean);

    console.log(
      `Fetched ${phases.length} phase(s) for project ${projectId} from board ${boardMeta.name}`
    );
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
    `&fields=name,due,start,labels,shortUrl,idList&customFieldItems=true`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Trello error for board ${boardId}: ${res.status} ${res.statusText}`
    );
  }

  const cards = await res.json();
  cards.forEach((card) => {
    console.log(
      `CARD (${companyLabel || "Unknown"}): ${card.name}`,
      "start:",
      card.start,
      "due:",
      card.due,
      "custom:",
      card.customFieldItems
    );

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
    map[list.id] = { name: list.name, company: companyLabel };
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

  const [cardResults, listResults] = await Promise.all([
    Promise.all(boardFetches),
    Promise.all(
      boardMeta.map((meta) => fetchBoardLists(meta.id, meta.label))
    ),
  ]);

  const cards = cardResults.flat();
  const listMeta = Object.assign({}, ...listResults);

  return cards.map((card) => ({
    ...card,
    _listMeta: listMeta[card.idList] || null,
  }));
}

// =======================
// MAP CARDS → GANTT TASKS
// =======================

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
      // ❌ No usable dates → skip for Gantt (but still appear in sidebar)
      console.log("Skipping (no dates):", card.name);
      return;
    }

    // 🟦 Debug log: confirm dates are parsed correctly
    console.log(
      `GANTT TASK: ${card.name}`,
      "| start:",
      startDate,
      "| end:",
      endDate
    );

    // 🟩 Label colouring
    const company = inferCompanyFromLabels(card.labels);
    const primaryLabel = card.labels && card.labels[0];
    const labelName = primaryLabel ? primaryLabel.name : null;

    const color =
      (labelName && LABEL_COLOURS[labelName]) ||
      LABEL_COLOURS[company] ||
      LABEL_COLOURS.Default;

    // 🟧 FINAL TASK OBJECT (note: start & end MUST be Date objects)
    tasks.push({
      id: card.id,
      name: card.name,
      start: startDate,
      end: endDate,
      progress: 0,
      custom_class: `task-${card.id}`,
      dependencies: "",
      _color: color,
      _shortUrl: card.shortUrl,
      _company: company,
    });
  });

  // ---------------------------------------------------------
  // 🔧 TEST TASK: known-good bar we can use to verify rendering
  // ---------------------------------------------------------
  tasks.push({
    id: "TEST1",
    name: "Test Gantt Bar",
    start: new Date("2025-01-01"),
    end: new Date("2025-02-01"),
    progress: 0,
    custom_class: "task-test",
    dependencies: "",
    _color: "#00ff00",
    _shortUrl: null,
    _company: "ME",
  });

  console.log("Added TEST task:", tasks[tasks.length - 1]);

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
      renderGanttFiltered();
    });

    companyChipsEl.appendChild(chip);
  });
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
    header.textContent = company;

    const icon = document.createElement("span");
    icon.className = "toggle-icon";
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
          const row = document.createElement("label");
          row.className = "project-toggle";

          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.checked = true;
          checkbox.dataset.cardId = card.id;
          activeProjectIds.add(card.id);

          checkbox.addEventListener("change", () => {
            if (checkbox.checked) {
              activeProjectIds.add(card.id);
            } else {
              activeProjectIds.delete(card.id);
            }
            renderGanttFiltered();
          });

          const span = document.createElement("span");
          span.textContent = card.name;

          row.appendChild(checkbox);
          row.appendChild(span);
          cardsContainer.appendChild(row);
        });

      listWrapper.appendChild(listHeader);
      listWrapper.appendChild(cardsContainer);
      listContainer.appendChild(listWrapper);
    });

    section.appendChild(header);
    section.appendChild(listContainer);
    projectsListEl.appendChild(section);
  });
}

if (holidayToggleEl) {
  holidayToggleEl.addEventListener("change", () => {
    includeHolidays = holidayToggleEl.checked;
    includeFamily = holidayToggleEl.checked;
    renderGanttFiltered();
  });
}

if (debugToggleEl) {
  debugToggleEl.addEventListener("change", () => {
    useDebugData = debugToggleEl.checked;
    renderGanttFiltered();
  });
}

if (holidayDebugToggleEl) {
  holidayDebugToggleEl.addEventListener("change", () => {
    useDebugHoliday = holidayDebugToggleEl.checked;
    renderGanttFiltered();
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

  const now = new Date();
  const windowStart = new Date(now);
  windowStart.setDate(windowStart.getDate() - 7);
  const windowEnd = new Date(now);
  windowEnd.setMonth(windowEnd.getMonth() + 3);

  const taskWithinWindow = (task) => {
    const startDate =
      task.start instanceof Date ? task.start : new Date(task.start);
    const endDate = task.end instanceof Date ? task.end : new Date(task.end);
    return endDate >= windowStart && startDate <= windowEnd;
  };

  const windowedProjects = tasksToShow.filter(taskWithinWindow);
  let windowedHolidays = includeHolidays
    ? holidayTasks.filter(taskWithinWindow)
    : [];
  let windowedFamily = includeFamily ? familyTasks.filter(taskWithinWindow) : [];
  if (includeHolidays && useDebugHoliday) {
    windowedHolidays = [];
    const firstStart = new Date(now);
    const firstEnd = new Date(firstStart);
    firstEnd.setDate(firstEnd.getDate() + 3);

    const secondStart = new Date(now);
    secondStart.setDate(secondStart.getDate() + 5);
    const secondEnd = new Date(secondStart);
    secondEnd.setDate(secondEnd.getDate() + 2);

    windowedHolidays.push(
      {
        id: "debug-holiday-1",
        name: "Debug Holiday 1",
        start: firstStart,
        end: firstEnd,
        progress: 0,
        custom_class: "holiday-task",
        dependencies: "",
        _color: LABEL_COLOURS.Holiday || "#ff5630",
        _shortUrl: null,
        _company: "Holiday",
        _debug: true,
      },
      {
        id: "debug-holiday-2",
        name: "Debug Holiday 2",
        start: secondStart,
        end: secondEnd,
        progress: 0,
        custom_class: "holiday-task",
        dependencies: "",
        _color: LABEL_COLOURS.Holiday || "#ff5630",
        _shortUrl: null,
        _company: "Holiday",
        _debug: true,
      }
    );
  }

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

  let projectTasks = [...sortedProjects];

  if (useDebugData) {
    const debugStart = new Date();
    const debugEnd = new Date(debugStart);
    debugEnd.setDate(debugEnd.getDate() + 14);

    projectTasks = [
      {
        id: "debug-task",
        name: "Debug Task (Today)",
        start: debugStart,
        end: debugEnd,
        progress: 0,
        custom_class: "debug-task",
        dependencies: "",
        _color: "#ff00ff",
        _shortUrl: null,
        _company: "Debug",
      },
    ];
  }

  const holidaySegments = includeHolidays
    ? windowedHolidays
        .map((task, idx) => {
          const start = ensureDate(task.start);
          const end = ensureDate(task.end);
          if (!start || !end) return null;
          const startStr = formatDateForTask(start);
          const endStr = formatDateForTask(end);
          if (!startStr || !endStr) return null;
          return {
            id: task.id || `holiday-${idx}`,
            start_date: startStr,
            end_date: endStr,
            duration: daysBetween(start, end),
            name: task.name,
            _shortUrl: task._shortUrl,
            _company: task._company,
            _startDate: start,
            _endDate: end,
            _summary: task._summary,
            _details: task._details,
            _source: task._debug ? "debug" : "ics",
            _color: task._color,
          };
        })
        .filter(Boolean)
    : [];

  const familySegments = includeFamily
    ? windowedFamily
        .map((task, idx) => {
          const start = ensureDate(task.start);
          const end = ensureDate(task.end);
          if (!start || !end) return null;
          const startStr = formatDateForTask(start);
          const endStr = formatDateForTask(end);
          if (!startStr || !endStr) return null;
          return {
            id: task.id || `family-${idx}`,
            start_date: startStr,
            end_date: endStr,
            duration: daysBetween(start, end),
            name: task.name,
            _shortUrl: task._shortUrl,
            _company: task._company,
            _startDate: start,
            _endDate: end,
            _summary: task._summary,
            _details: task._details,
            _source: "ics",
            _color: task._color,
          };
        })
        .filter(Boolean)
    : [];

  const filteredHolidaySegments = holidaySegments.filter((segment) => {
    if (useDebugHoliday) {
      return segment._source === "debug";
    }
    return segment._source !== "debug";
  });

  const filteredFamilySegments = familySegments;

  if (!projectTasks.length && !filteredHolidaySegments.length) {
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

  if (!normalizedProjects.length && !filteredHolidaySegments.length) {
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

  console.log(
    "Rendering dhtmlxGantt with tasks:",
    normalizedProjects,
    "holiday segments:",
    filteredHolidaySegments
  );

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
      };
    })
    .filter(Boolean);

  const dataset = [];
  const projectHierarchyNodes = [];

  const appendLane = (segments, laneId, laneLabel) => {
    if (!segments.length) return;
    const earliest = segments.reduce((min, seg) => {
      const segDate = ensureDate(seg.start_date);
      if (!segDate) return min;
      return segDate < min ? segDate : min;
    }, new Date(windowStart));

    const latest = segments.reduce((max, seg) => {
      const segDate = ensureDate(seg.end_date);
      if (!segDate) return max;
      return segDate > max ? segDate : max;
    }, new Date(windowEnd));

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
      duration: daysBetween(earliest, latest),
      progress: 0,
      render: "split",
      color: "transparent",
      progressColor: "transparent",
      _isHolidayLane: true,
      segments: laneSegments,
      _segments: laneSegments,
      _laneType: laneLabel,
    };

    dataset.push(laneTask);
  };

  appendLane(
    filteredHolidaySegments.filter((seg) => seg._company === "Holiday"),
    "holiday-lane",
    "Holidays"
  );
  appendLane(
    filteredFamilySegments.filter((seg) => seg._company === "Family"),
    "family-lane",
    "Family"
  );

  ganttProjectTasks.forEach((task) => {
    const parentId = `${task.id}-group`;
    const baseStartDate = ensureDate(task.start_date);
    const baseEndDate = ensureDate(task.end_date);

    projectHierarchyNodes.push({
      id: parentId,
      text: task.text,
      start_date: task.start_date,
      end_date: task.end_date,
      progress: task.progress,
      open: taskOpenState[parentId] ?? false,
      parent: 0,
      _company: task._company,
      _shortUrl: task._shortUrl,
      color: task.color,
      progressColor: task.progressColor,
      _cardId: task.id,
    });

    const phaseTasks = phasesByProjectId[task.id] || [];
    phaseTasks.forEach((phase) => {
      const phaseStart = ensureDate(phase.start);
      const phaseEnd = ensureDate(phase.end);
      if (!phaseStart || !phaseEnd) return;
      const phaseStartStr = formatDateForTask(phaseStart);
      const phaseEndStr = formatDateForTask(phaseEnd);
      if (!phaseStartStr || !phaseEndStr) return;
      projectHierarchyNodes.push({
        id: phase.id,
        text: phase.name,
        start_date: phaseStartStr,
        end_date: phaseEndStr,
        progress: 0,
        parent: parentId,
        color: phase._color,
        progressColor: phase._color,
        _company: phase._company,
        _shortUrl: phase._shortUrl,
        _cardId: phase.id,
      });
    });
  });

  dataset.push(...projectHierarchyNodes);

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

  const dateFmt = (date) => date.toISOString().substring(0, 10);
  const projectCount = useDebugData ? 1 : windowedProjects.length;
  const calendarCount =
    filteredHolidaySegments.length + filteredFamilySegments.length;
  summaryEl.textContent = `${projectCount} project(s) + ${calendarCount} calendar item(s) from ${dateFmt(
    windowStart
  )} to ${dateFmt(windowEnd)}${useDebugData ? " (debug data)" : ""}`;
}

// =======================
// MAIN FLOW
// =======================

async function loadFromTrello() {
  setStatus("Loading from Trello…");
  refreshBtn.disabled = true;

  try {
    const boardsPromise = fetchAllBoardsMeta();

    const [cards, holidays, family] = await Promise.all([
      fetchTrelloCards(),
      fetchHolidayTasks(),
      fetchFamilyTasks(),
    ]);
    await boardsPromise;
    await fetchPhasesForProjects(cards);
    allCards = cards;
    allTasks = mapCardsToTasks(cards);
    holidayTasks = holidays;
    familyTasks = family;

    renderCompanyChips();
    renderSidebar(cards);
    setStatus(
      `Loaded ${cards.length} card(s) (${allTasks.length} with dates), ${holidayTasks.length} holiday(s), ${familyTasks.length} family event(s).`
    );
    renderGanttFiltered();
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message}`);
    ganttContainer.textContent = "Failed to load data from Trello.";
  } finally {
    refreshBtn.disabled = false;
  }
}

// Wire refresh
refreshBtn.addEventListener("click", () => {
  loadFromTrello();
});

// Initial load
document.addEventListener("DOMContentLoaded", () => {
  if (!TRELLO_KEY || !TRELLO_TOKEN || (!ME_BOARD_ID && !LRL_BOARD_ID)) {
    setStatus(
      "Configure trelloKey/trelloToken and board IDs (ME_BoardId/LRL_BoardId) in config.js."
    );
    return;
  }
  // Kick off board catalog fetch for later use (phase lookups, etc.)
  fetchAllBoardsMeta();
  loadFromTrello();
});
