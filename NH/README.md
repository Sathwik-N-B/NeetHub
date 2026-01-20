# NeetHub

Chrome extension that mirrors LeetHub-style automation for NeetCode: capture accepted submissions and push them to a GitHub repository.

## Setup
1. Install dependencies:
   ```bash
   npm install
   ```
2. Configure GitHub OAuth device flow:
   - Create a GitHub OAuth App with device flow enabled.
   - Set the client ID in `src/lib/github.ts` (`CLIENT_ID`).
3. (Optional) Adjust permissions in `public/manifest.json` if you narrow host scopes.

## Development
- Dev (serves popup/options for rapid iteration):
  ```bash
  npm run dev
  ```
- Build the extension bundle:
  ```bash
  npm run build
  ```
- Zip the build for upload:
  ```bash
  npm run zip
  ```

## Loading in Chrome
1. Run `npm run build`.
2. Open `chrome://extensions`, enable Developer Mode.
3. Click **Load unpacked** and select the `dist` folder.

## How it works
- `content-neetcode.js` listens for `window.postMessage` events with `{ source: 'neetcode', type: 'submission', payload }` and forwards them to the background service worker.
- The background handles GitHub device flow auth, repository setup, and file commits.
- Popup/options pages let you set repo info, toggle uploads, and start auth.

## Future work
- Implement automatic scraping of NeetCode submission results and editor code.
- Add richer status in the popup (latest push, errors).
- Harden GitHub error handling and rate-limit retries.

## Notes
- The notification icon uses an inline data URL to avoid missing assets; replace if you prefer custom artwork.
