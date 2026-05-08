# ME Gantt Engine

This repo renders a Trello-backed Gantt chart with colour-coded bars. Follow the steps below to run the updated version that keeps task colours visible.

## Prerequisites
- A Trello API key and token.
- The ID of the Trello board that holds your portfolio cards.
- A static server (or simply open `index.html` in a browser).

## Setup
1. Create a `config.json` file in the project root (gitignored) using the example below.
2. Fill in your Trello credentials, board IDs, and the calendars you want to surface.
3. Run `python3 dev-server.py` and open http://localhost:8000.
4. Click **Refresh from Trello** to pull data — bars use each card's label/company colour and stay coloured after refreshes.

### Example `config.json`
```json
{
  "trelloKey": "YOUR_TRELLO_KEY",
  "trelloToken": "YOUR_TRELLO_TOKEN",
  "ME_BoardId": "YOUR_ME_BOARD_ID",
  "LRL_BoardId": "YOUR_LRL_BOARD_ID",
  "calendars": [
    { "key": "holiday", "label": "Holidays", "color": "#ff5630",
      "url": "https://outlook.office365.com/owa/calendar/.../calendar.ics" },
    { "key": "family",  "label": "Family",   "color": "#36b37e",
      "url": "https://outlook.office365.com/owa/calendar/.../calendar.ics" },
    { "key": "kjt",     "label": "KJT",      "color": "#0065ff",
      "url": "https://outlook.office365.com/owa/calendar/.../calendar.ics" }
  ]
}
```

`config.json` is the **only** local file you need to edit. `dev-server.py`
reads it at startup, mounts each calendar's URL at `/ics/<key>`, and serves
a synthesised `/config.js` to the browser with the upstream URLs stripped —
so the real Outlook URLs (which contain calendar-read tokens) never leave
the server. Calendar lanes appear under a collapsible **Calendars** group
at the top of the gantt; the proxy caches each feed for 5 minutes — restart
the server to bust it.
