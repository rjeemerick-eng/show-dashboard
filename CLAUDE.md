# RF Assign — Code Review Handoff

## What this is
Mac Electron app for church live production: assigns people to IEM packs, wireless mics, and production crew positions. An Express + WebSocket server (port 3000) runs inside Electron; any LAN device can open `/edit` (editor) or `/display` (backstage board) in a browser and everything syncs live. Formerly named "Show Dashboard" — repo and appId intentionally keep the old name.

- **Repo:** github.com/rjeemerick-eng/show-dashboard (public name: RF Assign)
- **Current version:** ~1.0.74 (check package.json / releases)
- **Owner:** rjeemerick@gmail.com, Apple Team ID 9BX9Z5V9U4

## Architecture
```
src/main.js        Electron main. Creates Editor + Display BrowserWindows, tray,
                   electron-updater wiring. Injects update-status JS into windows
                   via executeJavaScript — PLAIN STRING CONCAT ONLY (template
                   literals here have caused repeated syntax crashes).
server.js          Express + ws. Holds authoritative `state` object, broadcasts
                   on change, persists to disk (debounced saveStateSoon).
                   PCO API proxy (/api/pco/*), Shure receiver TCP poller,
                   playlist/tags/people/rules CRUD, export/import, connect-info.
public/editor.html Single-file editor UI (all CSS/JS inline).
public/display.html Single-file backstage board UI.
assets/icon.png    1024px app icon (electron-builder converts to icns).
.github/workflows/build.yml  Tag push -> mac runner -> sign/notarize -> GH release.
```

## State & data model
`state` = `{ serviceName, iems[14], mics[14], prod[], view{split,rightZone}, ros[] }`
- iems/mics rows: `{id, ch, role, name, photo, status, bat, wwbName, freq, mix/type}`
- prod rows: `{id, position(cg|cam|foh|mon|light|stage|dir|stream), role, name, photo, note, status}`
- Sync: clients send `{type:'update', payload}` over WS; server merges, saves, rebroadcasts.

**All persistence in `~/.show-dashboard/`** (survives app updates — files inside the
bundle are wiped every update; this was a real data-loss bug fixed in v1.0.59):
state.json, playlist.json, tags.json, people.json, rules.json, shure-devices.json.
PCO creds in `~/.show-dashboard-config.js`. One-time migration copies legacy
app-folder data if present.

## Integrations
- **Planning Center:** App ID + Personal Access Token entered in Settings; server
  proxies `/api/pco/*`. Load roster pulls people (+ photos) and plan items (run of
  show -> state.ros). Fresh load wipes board assignments and sets poolSource='pco'
  so dropdowns show only that week's people; go-live resets poolSource='tags'.
- **Shure live battery ("WWB data"):** WWB has no API. Server polls receivers
  directly — Shure Command Strings over TCP 2202, every 5s (pollAllShure).
  Sends `< GET n BATT_BARS >` + `< GET n CHAN_NAME >`, parses `< REP ... >`.
  Writes slot.bat (bars*20, 255=unknown->null) and slot.wwbName. Mapping UI in
  Settings→Integrations AND per-row "Wireless channel" select in the editor.
  Mappings keyed by slot INDEX, not role. PSM1000 has no return channel — IEM
  pack batteries are physically unavailable; users map vocalists' mic channels.
- **Templates:** position layouts + (since recent) a snapshot of shureDevs,
  saved to localStorage 'pos-template'.

## Release pipeline — CRITICAL RULES (each broke production when violated)
1. `package.json` build.mac MUST keep `"notarize": {"teamId": "9BX9Z5V9U4"}`.
2. Mac targets MUST include BOTH `dmg` AND `zip` — updater downloads the zip;
   dmg-only = update stuck at 0%.
3. `electron-updater` + `electron-log` stay in `dependencies` (not dev).
4. EVERY push: bump version in package.json AND push a matching NEW tag
   (`vX.Y.Z`). Repo release names come from package.json — a stale version
   silently overwrites an old release and updaters see "no update".
   Never move/reuse an existing tag.
5. `artifactName: "RF-Assign-${version}-${arch}.${ext}"` MUST stay — productName
   contains a space; without artifactName the zip blockmap uploads as
   "RF Assign-..." and GitHub 422s (already_exists loop).
6. `appId` stays `com.showdashboard.app`, npm `name` stays `show-dashboard`
   forever (updater chain + data continuity). Only productName/dmg.title are
   "RF Assign".

Release routine: copy changed files in, bump version, `git add`, commit,
`git tag vX.Y.Z`, `git push && git push origin vX.Y.Z`. Occasional GH Actions
infra failure ("cannot start any token" on checkout) -> bump + new tag.

## Recurring bug patterns to audit for (all have bitten before)
1. **Duplicate element IDs** from dead/stale panels left in HTML after UI moves.
   getElementById silently binds the wrong (hidden) element. Was the root cause
   of broken PCO connect and broken tag save.
2. **Duplicate function definitions** from repeated section rebuilds — last
   definition wins; a stale copy referencing a deleted element caused the
   persistent "Error checking for updates". checkForUpdates existed 3x,
   exportData/importData 3x each at one point.
3. **Template literals in main.js injected code** — syntax crashes; keep plain
   string concatenation in all `inject()` payloads.
4. **Files not actually copied before commit** — `git add` silently no-ops on
   unchanged paths; caused the icon and the banner-removal main.js to "ship"
   without shipping. Always check `git status --short` shows the expected files.
5. After any editor.html edit, run: extracted-JS `node --check`, duplicate-ID
   scan, duplicate-function scan, onclick/onchange-handler-defined scan,
   settings-panel div balance.

## Known open items / caveats
- Rename hop v1.0.64→65 changed artifact names; machines that failed that OTA
  hop need one manual DMG install.
- macOS Dock caches icons (`killall Dock` after icon changes).
- WWB CSV import (frequency coordination) discussed but NOT built.
- PWA manifest for iPad/iPhone home-screen install: proposed, not built.
- No auth on the LAN server — anyone on the network can open /edit. Acceptable
  for current deployments; flag if scope changes.
- Shure REP regex assumes single-digit channel (fine for 1–4 ch receivers).
- exportPDF uses window.open + document.write + window.print; user must enable
  "Print backgrounds".

## Requested review focus
1. server.js: WS merge semantics (`state = {...state, ...payload}`) — race
   conditions with multiple simultaneous editors; saveStateSoon debounce.
2. Shure poller: socket lifecycle (timeout/destroy/end), partial-buffer REP
   parsing, behavior when receiver IP is wrong/moved, polling all 4 channels on
   1/2-channel receivers (harmless? error REPs?).
3. editor.html: XSS surface — names/photo URLs from PCO and user input are
   interpolated into innerHTML in several renderers.
4. Update flow in main.js: fallback timer at 100%, quitAndInstall path,
   behavior when Settings panel (update-inline elements) isn't mounted.
5. General dedupe/dead-code sweep of editor.html (it has scars from many
   incremental panel rebuilds).
