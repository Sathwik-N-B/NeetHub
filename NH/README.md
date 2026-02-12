# LeetHub-3.0 (NeetHub Edition)

Chrome extension that brings LeetHub-style automation to NeetCode: automatically captures accepted submissions and pushes them to your GitHub repository with runtime/memory metrics.

## Features
- ✅ **LeetHub-style interface** - Clean popup with GitHub authentication flow
- ✅ **Problem statistics dashboard** - Track solved problems by difficulty (Easy/Medium/Hard)
- ✅ **Automatic submission capture** - Detects accepted solutions and auto-commits
- ✅ **Runtime & memory stats** - Captures performance metrics like LeetCode (e.g., "Time: 61ms, Memory: 63.4 MB")
- ✅ **Multi-language support** - Java, Python, C++, JavaScript, TypeScript, and more
- ✅ **Proper code formatting** - Preserves indentation from Monaco/CodeMirror editors
- ✅ **Problem metadata** - Includes difficulty, description, problem numbers in commits
- ✅ **Manual push button** - Toolbar button for on-demand commits

## Setup

### First-Time Installation
1. Install dependencies:
   ```bash
   npm install
   ```
2. Build the extension:
   ```bash
   npm run build
   ```
3. Load in Chrome:
   - Open `chrome://extensions`
   - Enable **Developer Mode**
   - Click **Load unpacked** → select the `dist` folder

4. **Click the extension icon** in your browser toolbar:
   - Click "Authenticate" to connect with GitHub (GitHub Device Flow)
   - Enter the code shown in the opened GitHub tab
   - Complete 2FA if enabled
   - Choose to create a new repository or link an existing one
   - Click "Get Started"

### Using LeetHub-3.0
1. Navigate to [NeetCode.io](https://neetcode.io) and solve a problem
2. Submit your solution - when accepted, LeetHub automatically:
   - Extracts your code with proper formatting
   - Detects the programming language
   - Captures runtime and memory metrics
   - Commits to GitHub with format: `Time: Xms, Memory: Y MB - LeetHub`
3. Files are organized as: `NeetCode/0001-problem-name/0001-problem-name.java`
4. View your progress in the extension popup with problem statistics

## Development
- **Dev mode** (for popup/options rapid iteration):
  ```bash
  npm run dev
  ```
- **Build the extension**:
  ```bash
  npm run build
  ```
- **Create distribution zip**:
  ```bash
  npm run zip
  ```

## Architecture

### Content Script (`src/content/neetcode.ts`)
- Monitors NeetCode page for submission acceptance
- Extracts code from Monaco editor using DOM traversal (preserves indentation)
- Detects language from dropdown button (`.editor-language-btn`)
- Captures runtime/memory from:
  1. Network response interceptor (fetch API)
  2. DOM text parsing (result panels)
  3. Full page text scan (fallback)
- Injects "Push to GitHub" toolbar button

### Background Service Worker (`src/background/index.ts`)
- Handles GitHub OAuth device flow authentication
- Manages repository operations via GitHub REST API
- Creates commits with formatted headers and stats

### Popup Interface (`src/popup/popup.html`, `src/popup/popup.ts`)
- LeetHub-inspired onboarding interface
- Shows setup view when not configured (authentication + repo selection)
- Shows configuration view once set up (repository settings, logout)
- Handles GitHub authentication flow and repository creation/linking

### Options Page
- Alternative settings interface
- View connection status
- Manual configuration controls

## How Code Extraction Works
1. **Monaco Editor**: Queries `.monaco-editor .view-lines .view-line` DOM nodes
2. **CodeMirror Fallback**: Checks `.cm-line` elements
3. **Line-by-line assembly**: Preserves whitespace by extracting `textContent` per line
4. **Non-breaking space normalization**: Converts `\u00a0` to regular spaces

## How Metrics Capture Works
1. **Network Interception**: Wraps `window.fetch()` to capture submission API responses
2. **DOM Parsing**: Scans result panels for "Time: X, Memory: Y" patterns
3. **Regex Extraction**: Matches numeric values like `61ms`, `63.4 MB`
4. **Fallback Chain**: API → DOM → page text → 'n/a'

## Configuration
- **CLIENT_ID**: Set in `src/lib/github.ts` (GitHub OAuth app)
- **Manifest**: `public/manifest.json` controls permissions and content scripts
- **Build**: `vite.config.ts` configures bundling and output

## Future Enhancements
- Add percentile rankings in commit messages (e.g., "99.83% faster")
- Support for contest submissions
- Batch commit mode for multiple problems
- Custom commit message templates
- Statistics dashboard in popup

## Troubleshooting
- **Metrics showing 'n/a'**: NeetCode may have changed their result panel structure. Check console logs for extraction attempts.
- **Wrong language detected**: Language dropdown may have changed selector. Check `.editor-language-btn`, `.language-selector`.
- **Code indentation lost**: Monaco editor DOM structure changed. Update `.view-lines .view-line` selectors.

## Notes
- Metrics extraction uses dual-source approach: network responses (primary) + DOM parsing (fallback)
- Language detection priority: dropdown button → localStorage → Monaco API → code pattern matching
- Folder structure uses zero-padded problem numbers: `0001-two-sum`, `0125-valid-palindrome`

---

**Inspired by LeetHub-3.0** | Built for NeetCode users
