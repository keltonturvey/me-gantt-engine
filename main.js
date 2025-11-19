// main.js

// =======================
// CONFIG BRIDGE
// =======================

if (!window.ME_GANTT_CONFIG) {
  console.error("ME_GANTT_CONFIG not found. Did you create config.js?");
}

const TRELLO_KEY = window.ME_GANTT_CONFIG?.trelloKey || "";
const TRELLO_TOKEN = window.ME_GANTT_CONFIG?.trelloToken || "";
const BOARD_ID = window.ME_GANTT_CONFIG?.portfolioBoardId || "";

// Label → colour mapping (tweak as you like)
const LABEL_COLOURS = {
  ME: "#00b8d9",
  LRL: "#ff991f",
  Holiday: "#ff5630",
  Default: "#0052cc"
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

let ganttInstance = null;
let allCards = [];
let allTasks = [];
let activeProjectIds = new Set();
let companyFilter = {
  ME: true,
  LRL: true,
  Other: true
};

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
  const names = labels.map(l => (l.name || "").toUpperCase());
  if (names.includes("ME")) return "ME";
  if (names.includes("LRL")) return "LRL";
  return "Other";
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
    `&fields=name,due,start,labels,shortUrl`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Trello error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

// =======================
// MAP CARDS → GANTT TASKS
// =======================

function mapCardsToTasks(cards) {
  const tasks = [];

  cards.forEach(card => {
    const due = card.due ? new Date(card.due) : null;
    const start = card.start ? new Date(card.start) : null;

    let startDate, endDate;

    if (start && due) {
      startDate = start;
      endDate = due;
    } else if (start && !due) {
      startDate = start;
      endDate = new Date(start.getTime());
      endDate.setDate(endDate.getDate() + 7);
    } else if (!start && due) {
      endDate = due;
      startDate = new Date(due.getTime());
      startDate.setDate(startDate.getDate() - 7);
    } else {
      // no dates → don't show in Gantt (still appears in sidebar)
      return;
    }

    const company = inferCompanyFromLabels(card.labels);
    const primaryLabel = card.labels && card.labels[0];
    const labelName = primaryLabel ? primaryLabel.name : null;
    const color =
      (labelName && LABEL_COLOURS[labelName]) ||
      LABEL_COLOURS[company] ||
      LABEL_COLOURS.Default;

    tasks.push({
      id: card.id,
      name: card.name,
      start: fmtDate(startDate),
      end: fmtDate(endDate),
      progress: 0,
      custom_class: `task-${card.id}`,
      dependencies: "",
      _color: color,
      _shortUrl: card.shortUrl,
      _company: company
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
    { key: "Other", label: "Other", color: "#cccccc" }
  ];

  companies.forEach(c => {
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

  sorted.forEach(card => {
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

// =======================
// GANTT RENDERING
// =======================

function renderGanttFiltered() {
  const tasksToShow = allTasks.filter(task => {
    if (!activeProjectIds.has(task.id)) return false;
    if (!companyFilter[task._company]) return false;
    return true;
  });

  ganttContainer.innerHTML = "";

  if (!tasksToShow.length) {
    ganttContainer.textContent =
      "No tasks to display. Try enabling more projects or companies.";
    summaryEl.textContent = "";
    return;
  }

  const div = document.createElement("div");
  div.id = "gantt";
  ganttContainer.appendChild(div);

  ganttInstance = new Gantt("#gantt", tasksToShow, {
    view_mode: "Month",
    date_format: "YYYY-MM-DD",
    custom_popup_html: task => {
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
    }
  });

  // Colour bars by our chosen colour
  tasksToShow.forEach(t => {
    const sel = `.bar-wrapper[data-id="${t.id}"] .bar`;
    const el = document.querySelector(sel);
    if (el && t._color) {
      el.style.fill = t._color;
    }
  });

  summaryEl.textContent = `${tasksToShow.length} project(s) shown`;
}

// =======================
// MAIN FLOW
// =======================

async function loadFromTrello() {
  setStatus("Loading from Trello…");
  refreshBtn.disabled = true;

  try {
    const cards = await fetchTrelloCards();
    allCards = cards;
    allTasks = mapCardsToTasks(cards);

    renderCompanyChips();
    renderSidebar(cards);
    setStatus(
      `Loaded ${cards.length} card(s) (${allTasks.length} with dates) from Trello.`
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
