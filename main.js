// main.js

// =======================
// CONFIG BRIDGE
// =======================

if (!window.ME_GANTT_CONFIG) {
  console.error("ME_GANTT_CONFIG not found. Did you create config.js?");
}

console.log("Is Gantt loaded?", typeof Gantt);

const TRELLO_KEY = window.ME_GANTT_CONFIG?.trelloKey || "";
const TRELLO_TOKEN = window.ME_GANTT_CONFIG?.trelloToken || "";
const BOARD_ID = window.ME_GANTT_CONFIG?.portfolioBoardId || "";
const HOLIDAY_ICS_URL = window.ME_GANTT_CONFIG?.holidayICS || "";

// Label → colour mapping (tweak as you like)
const LABEL_COLOURS = {
  ME: "#00b8d9",
  LRL: "#ff991f",
  Holiday: "#ff5630",
  Default: "#0052cc",
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

let ganttInstance = null;
let allCards = [];
let allTasks = [];
let holidayTasks = [];
let activeProjectIds = new Set();
let companyFilter = {
  ME: true,
  LRL: true,
  Other: true,
};
let includeHolidays = holidayToggleEl ? holidayToggleEl.checked : false;
let useDebugData = debugToggleEl ? debugToggleEl.checked : false;
let useDebugHoliday = holidayDebugToggleEl ? holidayDebugToggleEl.checked : false;

// =======================
// STYLE HELPERS
// =======================

function applyGanttColours(tasks) {
  if (!ganttInstance || !ganttInstance.$svg) return;

  tasks.forEach((t) => {
    const wrapper = ganttInstance.$svg.querySelector(
      `.bar-wrapper[data-id="${t.id}"]`
    );
    if (!wrapper) return;

    const bar = wrapper.querySelector(".bar");
    const progress = wrapper.querySelector(".bar-progress");

    if (bar && t._color) {
      bar.style.fill = t._color;
      bar.style.stroke = t._color;
    }

    if (progress && t._color) {
      // Slightly darker shade for progress fill for visibility
      progress.style.fill = t._color;
    }
  });
}

function stackHolidayBars(events) {
  if (!ganttInstance || !events.length) return;

  const wrappers = events
    .map((evt) =>
      ganttInstance.$svg?.querySelector(`.bar-wrapper[data-id="${evt.id}"]`)
    )
    .filter(Boolean);

  if (!wrappers.length) return;

  const getTransform = (wrapper) => {
    const transform = wrapper.getAttribute("transform") || "translate(0,0)";
    const match = transform.match(/translate\(([^,]+),\s*([^)]+)\)/);
    if (!match) return { x: 0, y: 0 };
    return { x: parseFloat(match[1]), y: parseFloat(match[2]) };
  };

  const baseY = Math.min(
    ...wrappers.map((wrapper) => getTransform(wrapper).y)
  );

  wrappers.forEach((wrapper) => {
    const { x } = getTransform(wrapper);
    wrapper.setAttribute("transform", `translate(${x}, ${baseY})`);
  });
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
          events.push({
            summary: current.SUMMARY || "Holiday",
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
        name: `Holiday: ${evt.summary}`,
        start: evt.start,
        end: evt.end,
        progress: 0,
        custom_class: "holiday-task",
        dependencies: "",
        _color: LABEL_COLOURS.Holiday || "#ff5630",
        _shortUrl: null,
        _company: "Holiday",
      }));

    console.log(`Loaded ${mapped.length} holiday event(s) from ICS`);
    return mapped;
  } catch (err) {
    console.warn("Failed to load holiday ICS:", err);
    return [];
  }
}

// =======================
// TRELLO FETCH
// =======================

async function fetchTrelloCards() {
  if (!TRELLO_KEY || !TRELLO_TOKEN || !BOARD_ID) {
    throw new Error(
      "Missing TRELLO_KEY / TRELLO_TOKEN / BOARD_ID. Check config.js."
    );
  }

  const url =
    `https://api.trello.com/1/boards/${BOARD_ID}/cards` +
    `?key=${encodeURIComponent(TRELLO_KEY)}` +
    `&token=${encodeURIComponent(TRELLO_TOKEN)}` +
    `&fields=name,due,start,labels,shortUrl&customFieldItems=true`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Trello error: ${res.status} ${res.statusText}`);
  }

  const cards = await res.json();

  // 🔥 Add debug logging for every card
  cards.forEach((card) => {
    console.log(
      `CARD: ${card.name}`,
      "start:",
      card.start,
      "due:",
      card.due,
      "custom:",
      card.customFieldItems
    );
  });

  return cards;
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

  // Sort by company then name
  const sorted = [...cards].sort((a, b) => {
    const ca = inferCompanyFromLabels(a.labels);
    const cb = inferCompanyFromLabels(b.labels);
    if (ca < cb) return -1;
    if (ca > cb) return 1;
    return a.name.localeCompare(b.name);
  });

  sorted.forEach((card) => {
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
    projectsListEl.appendChild(row);
  });
}

if (holidayToggleEl) {
  holidayToggleEl.addEventListener("change", () => {
    includeHolidays = holidayToggleEl.checked;
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

  ganttContainer.innerHTML = "";

  const windowedProjects = tasksToShow.filter(taskWithinWindow);
  const windowedHolidays = includeHolidays
    ? holidayTasks.filter(taskWithinWindow)
    : [];
  if (includeHolidays && useDebugHoliday) {
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
      }
    );
  }

  let combinedTasks = [
    ...windowedHolidays,
    ...windowedProjects.sort((a, b) => a.start - b.start),
  ];

  if (useDebugData) {
    const debugStart = new Date();
    const debugEnd = new Date(debugStart);
    debugEnd.setDate(debugEnd.getDate() + 14);

    combinedTasks = [
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

  if (!combinedTasks.length) {
    ganttContainer.textContent =
      "No tasks in the current date window. Adjust filters or try again later.";
    summaryEl.textContent = "";
    return;
  }

  const monthDiff =
    (windowEnd.getFullYear() - windowStart.getFullYear()) * 12 +
    (windowEnd.getMonth() - windowStart.getMonth()) +
    1;
  const availableWidth =
    ganttContainer.clientWidth ||
    ganttContainer.offsetWidth ||
    window.innerWidth ||
    600;
  const columnWidth = Math.max(
    60,
    Math.floor(availableWidth / Math.max(1, monthDiff))
  );

  const tightMonthView = {
    name: "Month",
    padding: "0m",
    step: "1m",
    column_width: columnWidth,
    date_format: "YYYY-MM",
    lower_text: (date) =>
      date.toLocaleString(undefined, { month: "long" }),
    upper_text: (date, prevDate) =>
      !prevDate || date.getFullYear() !== prevDate.getFullYear()
        ? date.getFullYear().toString()
        : "",
    thick_line: (date) => date.getMonth() % 3 === 0,
    snap_at: "7d",
  };
  const windowAnchors = [
    {
      id: "window-start-anchor",
      name: "Window Start Anchor",
      start: windowStart,
      end: windowStart,
      progress: 0,
      custom_class: "window-anchor",
      dependencies: "",
      _color: "transparent",
      _shortUrl: null,
      _company: "Window",
    },
    {
      id: "window-end-anchor",
      name: "Window End Anchor",
      start: windowEnd,
      end: windowEnd,
      progress: 0,
      custom_class: "window-anchor",
      dependencies: "",
      _color: "transparent",
      _shortUrl: null,
      _company: "Window",
    },
  ];

  combinedTasks = [...combinedTasks, ...windowAnchors];

  const div = document.createElement("div");
  div.id = "gantt";
  ganttContainer.appendChild(div);

  // 🔥 DEBUG
  console.log("Rendering Gantt with tasks:", combinedTasks);

  // ----------------------------------------------------------
  // 🚀 THE FIX: Normalize tasks into strict YYYY-MM-DD strings
  // ----------------------------------------------------------
  const ganttReadyTasks = combinedTasks.map((t) => ({
    ...t,
    start:
      t.start instanceof Date
        ? t.start.toISOString().substring(0, 10)
        : t.start,

    end: t.end instanceof Date ? t.end.toISOString().substring(0, 10) : t.end,
  }));

  console.log("Normalized tasks:", ganttReadyTasks);

  // ----------------------------------------------------------
  // 🚀 RENDER GANTT
  // ----------------------------------------------------------
  ganttInstance = new Gantt("#gantt", ganttReadyTasks, {
    view_mode: "Month",
    view_modes: [tightMonthView],
    bar_height: 24,
    padding: 0,
    infinite_padding: false,
    column_width: columnWidth,
    height: "100%", // <-- key line
    date_format: "YYYY-MM-DD",

    custom_popup_html: (task) => {
      const url = task._shortUrl
        ? `<div><a href="${task._shortUrl}" target="_blank">Open in Trello</a></div>`
        : "";

      return `
        <div class="details-container">
          <h5>${task.name}</h5>
          <p>${task.start} → ${task.end}</p>
          <p>Company: ${task._company}</p>
          ${url}
        </div>
      `;
    },
  });

  // ----------------------------------------------------------
  // 🎨 APPLY COLOURS AFTER RENDER
  // ----------------------------------------------------------
  applyGanttColours(ganttReadyTasks);
  stackHolidayBars(windowedHolidays);

  // Force a refresh of the visible date window
  setTimeout(() => {
    ganttInstance.change_view_mode("Month");
    applyGanttColours(ganttReadyTasks);
    stackHolidayBars(windowedHolidays);
    if (ganttInstance.set_scroll_position) {
      ganttInstance.set_scroll_position(windowStart);
    }
  }, 50);

  const dateFmt = (date) => date.toISOString().substring(0, 10);
  const projectCount = useDebugData ? 1 : windowedProjects.length;
  summaryEl.textContent = `${projectCount} project(s) + ${
    windowedHolidays.length
  } holiday(s) from ${dateFmt(windowStart)} to ${dateFmt(windowEnd)}${
    useDebugData ? " (debug data)" : ""
  }`;
}

// =======================
// MAIN FLOW
// =======================

async function loadFromTrello() {
  setStatus("Loading from Trello…");
  refreshBtn.disabled = true;

  try {
    const [cards, holidays] = await Promise.all([
      fetchTrelloCards(),
      fetchHolidayTasks(),
    ]);
    allCards = cards;
    allTasks = mapCardsToTasks(cards);
    holidayTasks = holidays;

    renderCompanyChips();
    renderSidebar(cards);
    setStatus(
      `Loaded ${cards.length} card(s) (${allTasks.length} with dates) and ${holidayTasks.length} holiday(s).`
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
  if (!TRELLO_KEY || !TRELLO_TOKEN || !BOARD_ID) {
    setStatus(
      "Configure trelloKey, trelloToken, and portfolioBoardId in config.js."
    );
    return;
  }
  loadFromTrello();
});
