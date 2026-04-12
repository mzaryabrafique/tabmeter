# TabMeter: Tab Time Tracker

A Chrome/Edge extension that tracks active time spent per website hostname while a tab is focused and browser activity is detected.

## 🚀 Features

- Tracks time on active tabs (`http` and `https` only)
- Pauses tracking when user is idle or window is unfocused
- Stores daily stats locally via `chrome.storage.local`
- `popup.html` shows:
  - Today/Week/All time breakdown
  - Top sites list with mini bar indicators
  - One-week stacked chart
  - Active status message with session context
- Privacy-friendly: all data remains on device

## 📁 Repository structure

- `manifest.json` - Chrome extension manifest (v3)
- `background.js` - service worker for activity tracking and timing
- `popup.html` - UI
- `popup.css` - styling
- `popup.js` - UI logic, charts, visitor stats
- `privacy.html` - privacy notice
- `icons/` - icon resources

## 🛠️ How it works (key flow)

1. `background.js` sets an alarm each minute and listens for:
   - tab activation, updates, removal
   - window focus changes
   - idle state changes
2. Active session state is kept in `chrome.storage.session.activeSession`
3. `flushSession` adds elapsed seconds into `chrome.storage.local.stats.days` daily bucket
4. `popup.js` reads `stats.days` and renders lists + charts and active session status

## 🧪 Install locally (dev)

1. Open browser extension page:
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
2. Enable Developer mode
3. Click `Load unpacked`
4. Choose this folder (`tab-time-tracking`)
5. Pin the extension and open popup

## ⚙️ Permissions

- `storage`
- `tabs`
- `windows`
- `alarms`
- `idle`

## 🧾 Release notes

- `1.0.2` (current): baseline stable implementation

## 📌 Known behavior

- Not records non-http(s) tabs (chrome://, file:// etc)
- Idle after 60s stops current timing
- Stats are persisted per calendar day key (`YYYY-MM-DD`)

## 🛡️ Privacy

- No external server calls
- No user-identifying data stored (sites only by hostname)
- Data is local and time-based only

## 🧩 Development notes

- Use 1-minute interval flush via `chrome.alarms` in background
- Session keyed by active tabId + windowId + hostname
- `popup.js` supports range toggles: `today`, `week`, `all` and view toggles: `list`, `chart`

---

If you want next, I can also add a CONTRIBUTING section and minimal style guide in the README.