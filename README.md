# Show Dashboard — Desktop App

Native Mac app that bundles the dashboard server + UI into a double-click installer.
Auto-updates over the air from GitHub Releases.

---

## First time setup

### 1. Create the GitHub repo

```bash
cd ~/Downloads/show-dashboard-app
git init
git add .
git commit -m "Initial commit"
gh repo create show-dashboard --public --push --source=.
```

(Install GitHub CLI first if needed: `brew install gh && gh auth login`)

### 2. Add GH_TOKEN secret to GitHub

1. Go to github.com/rjeemerick-eng/show-dashboard/settings/secrets/actions
2. Click "New repository secret"
3. Name: `GH_TOKEN`
4. Value: your GitHub personal access token (Settings → Developer settings → Personal access tokens → Fine-grained → create with "Contents" write permission)

### 3. Add app icon

Place your icon at `assets/icon.icns` (Mac icon format, 1024×1024 recommended).
You can convert a PNG using: `brew install iconutil` or use an online converter.

Optional: add `assets/dmg-background.png` (540×380px) for the DMG installer background.

---

## Publishing a new release (triggers auto-build + DMG)

```bash
# Bump version in package.json first, then:
git add .
git commit -m "Release v1.0.1"
git tag v1.0.1
git push && git push --tags
```

GitHub Actions builds the DMG and publishes it as a GitHub Release automatically.
All installed apps check for updates every 30 minutes and prompt to install.

---

## Running locally (dev)

```bash
npm install
npm start
```

---

## How OTA updates work

1. You push a new git tag (e.g. `v1.0.2`)
2. GitHub Actions builds a new DMG and publishes it to GitHub Releases
3. All running instances of the app check GitHub every 30 min
4. When an update is found, it downloads in the background
5. The menu bar icon shows "Update ready — click to restart"
6. User clicks → app restarts with new version

No user action needed except the final restart click.

---

## Code signing (recommended)

Without code signing, macOS shows a security warning on first open.
Users can bypass it: right-click → Open → Open anyway.

To sign properly, you need an Apple Developer account ($99/yr).
Add these secrets to GitHub:
- `CSC_LINK` — base64-encoded .p12 certificate
- `CSC_KEY_PASSWORD` — certificate password
- `APPLE_ID` — your Apple ID email
- `APPLE_APP_SPECIFIC_PASSWORD` — app-specific password from appleid.apple.com
- `APPLE_TEAM_ID` — your 10-char team ID

Then uncomment the signing lines in `.github/workflows/build.yml`.

---

## File structure

```
show-dashboard-app/
├── src/
│   └── main.js          ← Electron main process
├── public/              ← Dashboard web UI (display + editor)
├── server.js            ← Express + WebSocket server (embedded)
├── config.js            ← PCO credentials
├── assets/
│   ├── icon.icns        ← App icon
│   └── dmg-background.png
├── scripts/
│   └── notarize.js      ← Apple notarization
├── .github/
│   └── workflows/
│       └── build.yml    ← Auto-build pipeline
└── package.json
```
