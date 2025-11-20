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
};
```

## What changed
- `main.js` now reapplies each task's colour to the bar and progress fill after render and after view-mode refreshes. No extra steps are required beyond loading the page with your `config.js` present.
