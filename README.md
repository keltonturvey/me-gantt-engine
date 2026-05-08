# ME Gantt Engine

This repo renders a Trello-backed Gantt chart with colour-coded bars. Follow the steps below to run the updated version that keeps task colours visible.

## Prerequisites
- A Trello API key and token.
- The ID of the Trello board that holds your portfolio cards.
- A static server (or simply open `index.html` in a browser).

## Setup
1. Copy `config.js.example` from below into a new `config.js` file in the project root.
2. Replace the placeholder values with your Trello credentials and board ID.
3. Open `index.html` locally (or serve the folder with any static server).
4. Click **Refresh** to pull data from Trello—the bars will use each task's label/company colour and stay coloured after refreshes.

### Example `config.js`
```js
window.ME_GANTT_CONFIG = {
  trelloKey: "YOUR_TRELLO_KEY",
  trelloToken: "YOUR_TRELLO_TOKEN",
  portfolioBoardId: "YOUR_BOARD_ID",
  calendars: [
    { key: "holiday", label: "Holidays", color: "#ff5630", url: "/ics/holiday" },
    { key: "family",  label: "Family",   color: "#36b37e", url: "/ics/family"  },
    // Add one entry per person. `key` must match the lowercased prefix of
    // the matching <NAME>_ICS_URL in .env.
  ],
};
```

## What changed
- `main.js` now reapplies each task's colour to the bar and progress fill after render and after view-mode refreshes. No extra steps are required beyond loading the page with your `config.js` present.

## Running locally with calendar lanes

The Outlook ICS endpoints don't allow direct browser fetches (CORS), so use
the included `dev-server.py` to serve the page and proxy each calendar feed.

The proxy auto-registers a route per `<NAME>_ICS_URL` env var, mapping it to
`/ics/<name>` (lowercased). Add one variable per calendar you want to expose
— holidays, family, and one per team member is a common shape.

1. Create a `.env` next to `dev-server.py`:
   ```
   HOLIDAY_ICS_URL="https://outlook.office365.com/owa/calendar/.../calendar.ics"
   FAMILY_ICS_URL="https://outlook.office365.com/owa/calendar/.../calendar.ics"
   KJT_ICS_URL="https://outlook.office365.com/owa/calendar/.../calendar.ics"
   # …one per person
   ```
2. Add a matching entry to `calendars` in `config.js` (see example above).
3. Run:
   ```
   python3 dev-server.py
   ```
4. Open `http://localhost:8000`. Calendar lanes appear under a collapsible
   **Calendars** group at the top of the gantt; the proxy caches each feed
   for 5 minutes — restart the server to bust it.
