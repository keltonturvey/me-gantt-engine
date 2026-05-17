# Project Start Checklist

Run this whenever a new client project lands at Lambert Rubicon. The five
resources below — SharePoint, Miro, Trello, dev server, GitHub repo — all need
to exist and be cross-linked before kickoff. Tick the boxes as you go; the
project isn't "started" until every "Done when" sentence is true.

```
Project:        ____________________
Client:         ____________________
Sponsor (client): __________________
Lead (LR):      ____________________
Start:          ____________________
Target due:     ____________________
```

## 0. Define before doing anything

- [ ] Project codename agreed (used identically across all 5 systems)
- [ ] One-line description written ("what we're delivering")
- [ ] Scope basis confirmed (T&M / fixed / retainer)
- [ ] Lead + sponsor + main client contact identified

## 1. SharePoint site (client data share)

- [ ] Site created at `Clients/<client>/<project>`
- [ ] Standard folder structure:
  - `01 Contracts` · `02 Specs` · `03 Inputs from client` · `04 Deliverables`
  - `05 Comms` · `06 Misc`
- [ ] Permissions: client sponsor + main contact (Edit), LR team (Edit), no public links
- [ ] Existing client data uploaded (kickoff brief, prior emails, anything relevant)
- [ ] URL pinned in the Trello project card description
- **Done when:** sponsor can open the site, see the structure, and upload a file.

## 2. Miro board (visual overview)

- [ ] Board created from the Miro Project Template
- [ ] Renamed to match project codename
- [ ] Default frames present: System overview · User journey · Architecture · Roadmap
- [ ] Sponsor + team invited (Editor); rest of client side (Viewer)
- [ ] URL pinned in the Trello project card description
- **Done when:** the board has at least one diagram on the System overview frame.

## 3. Trello (task management)

### Portfolio side (ME or LRL board)

- [ ] Project card created on the portfolio board
- [ ] **Start** and **due** dates set (drives the Gantt parent bar)
- [ ] `ME` or `LRL` label applied; priority label if relevant

### Project board

- [ ] New board created from the **Project Template** board
- [ ] Renamed to `ME <Project>` or `LRL <Project>` so the Gantt engine matches
  it to the portfolio card (see `normalizeProjectName()` in `main.js`)
- [ ] LR team added as board members
- [ ] Client sponsor + key contact(s) added as **Workspace Guests** on this board only
  (Guests don't consume paid seats — keep them off other workspace boards)
- [ ] **Phases** list populated with real phases, each with start + due dates
  (the list must be named exactly `Phases` for the Gantt engine to pick it up)

### Client-visible expectations

- [ ] Pinned `Welcome — How to use this board` card in the leftmost list explaining:
  - What clients can do (view, comment, react)
  - What they should NOT do (move cards, change dates, add lists)
  - Where change requests go (comment on the card, don't open new ones)
- [ ] Team aware: **comments and card descriptions are client-visible** — internal
  thinking goes in Miro or in a separate Trello card not shared with the client

### Cross-linking

- [ ] Card description holds links to SharePoint · Miro · dev URL · GitHub repo
- **Done when:** opening the Gantt shows this project nested under its company with
  real phase bars, and the client sponsor can comment on a card from their account.

## 4. Dev server (Proxmox + Cloudflare)

- [ ] Proxmox VM/LXC provisioned from the standard template
  - Hostname: `<project>` (matches Trello codename, lowercase-with-dashes)
  - Resources sized to the project (default: 2 vCPU / 4 GB RAM / 40 GB disk)
  - Static IP assigned on the office LAN (note it in the 1Password entry below)
- [ ] OS hardened: firewall up, root SSH disabled, team SSH keys added,
  unattended-upgrades on
- [ ] Cloudflare Tunnel created for this project
  - Tunnel name: `<project>-dev`
  - `cloudflared` installed + running on the VM as a systemd service
  - Tunnel credentials stored in 1Password under the entry below
- [ ] Cloudflare DNS record
  - `CNAME <project>.dev.lambertrubicon.com → <tunnel-id>.cfargotunnel.com`
  - Proxied (orange cloud)
- [ ] Cloudflare Access policy on the hostname
  - Allowed identities: `@lambertrubicon.com` emails + named client contacts if needed
  - Session duration: 24h (or whatever the LR default is)
- [ ] SSL mode: **Full (strict)**; origin certificate installed on the VM
- [ ] Backup: Proxmox snapshot schedule set (default: nightly, retain 7 days)
- [ ] Smoke test: open `https://<project>.dev.lambertrubicon.com` from outside the
  office, authenticate through Cloudflare Access, see the placeholder / 200
- **Done when:** the URL works from a phone on cellular, behind Cloudflare Access,
  and tomorrow morning's snapshot shows up in the Proxmox backup list.

## 5. GitHub repo

- [ ] Repo created at `lambert-rubicon/<project>` (or the org's actual naming)
- [ ] Private visibility confirmed
- [ ] README populated: client, sponsor, dev URL, SharePoint link, Miro link,
  Trello link, 1Password search hint
- [ ] Default branch protection: PR required, at least 1 review
- [ ] CI scaffolded (build + test, even if minimal)
- [ ] Deploy to dev server wired up (push to `main` → auto-deploy via cloudflared
  tunnel or whatever pattern the project uses)
- [ ] `.gitignore` + `.env.example` in place; real `.env` never committed
- [ ] Team added with appropriate permissions
- **Done when:** a "hello world" commit goes through CI and shows up on the dev URL.

## 1Password convention

Apply on every project so the team can find any credential by typing the codename.

- [ ] All entries in the shared **`Projects`** vault (or a per-client vault for
  larger clients)
- [ ] Entries named **`<project> — <thing>`**, picking from:
  - `<project> — Cloudflare Tunnel` (tunnel id + JSON creds)
  - `<project> — Dev VM SSH` (hostname, port, internal IP)
  - `<project> — Dev DB` (connection string + creds)
  - `<project> — App admin` (login for the running app)
  - `<project> — Client SharePoint` (if it has its own creds)
  - `<project> — Third-party API` (one per integration if any)
- [ ] Every entry tagged `project:<project>` + `client:<client>`
- [ ] Trello project card description has a one-line `1Password: search "<project>"` pointer
- **Done when:** typing the project codename into 1Password returns every
  credential someone working on it needs, and nothing they shouldn't see.

## Done state for the project

- [ ] All 5 resources above exist and are linked from the Trello project card
- [ ] Kickoff meeting scheduled (calendar invite sent)
- [ ] All team members can access all 5 resources
- [ ] Project visible on the Gantt with parent bar + phase rows

## Worth considering (per project, optional)

- [ ] Dedicated Teams channel for this project's comms
- [ ] Time-tracking project code created (Toggl / Harvest / etc.)
- [ ] Standing weekly status call with sponsor
- [ ] Risk register opened (one row, one risk; can live on the Miro Roadmap frame)
