import type { SubmissionPayload } from '../lib/github';
import type { Settings } from '../lib/storage';

// Inline logger functions to avoid import issues in content script
function log(...args: unknown[]) {
  console.log('[NeetHub]', ...args);
}

function warn(...args: unknown[]) {
  console.warn('[NeetHub]', ...args);
}


// Ensure DOM is ready before injecting
function initializeExtension() {
  try {
    // Inject on-page UI panel
    injectPanel();
    setupPanelListeners();

    // Auto-capture: hook fetch/XHR to detect submission responses
    patchFetch();
    patchXhr();

    log('NeetHub initialized');
  } catch (err) {
    warn('NeetHub initialization failed', err);
  }
}

if (document.body) {
  initializeExtension();
} else {
  document.addEventListener('DOMContentLoaded', initializeExtension);
}

// Passive listener for manual injections from page context
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== 'neetcode' || data.type !== 'submission') return;

  const payload = data.payload as SubmissionPayload;
  if (!payload?.code) {
    warn('NeetHub: submission payload missing code');
    return;
  }

  void pushSubmission(payload, 'postMessage');
});

let recentKeys = new Set<string>();
const RECENT_TTL_MS = 10 * 60 * 1000; // dedupe window

// NeetCode endpoints observed in DevTools; treat these as submission-related
const NEETCODE_ENDPOINT_HINTS = [
  'submission',
  'submit',
  'judge',
  'runCodeFunctionHttp',
  'executeCodeFunctionHttp',
];

function urlLooksLikeSubmission(url?: string): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  return NEETCODE_ENDPOINT_HINTS.some((hint) => lower.includes(hint)) && lower.includes('neetcode');
}

function debugCapture(url: string, requestBody: unknown, responseData: unknown) {
  try {
    console.group('[NeetHub] Captured NeetCode API');
    console.info('URL:', url);
    console.info('Request body:', requestBody);
    console.info('Response:', responseData);
    console.groupEnd();
  } catch {}
  try {
    logPanel(
      `Captured API: ${url}\nRequest: ${JSON.stringify(requestBody)}\nResponse: ${JSON.stringify(
        responseData
      )}`
    );
  } catch {}
}

function injectPanel() {
  const panel = document.createElement('div');
  panel.id = 'neethub-panel';
  panel.innerHTML = `
    <style>
      #neethub-panel {
        position: fixed;
        top: 60px;
        right: 0;
        width: 300px;
        max-height: 500px;
        background: #fff;
        border-left: 1px solid #e5e7eb;
        box-shadow: -2px 0 8px rgba(0,0,0,0.1);
        border-radius: 8px 0 0 8px;
        z-index: 9999;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        overflow-y: auto;
      }
      #neethub-panel * {
        box-sizing: border-box;
      }
      .nh-header {
        padding: 12px;
        border-bottom: 1px solid #e5e7eb;
        font-weight: 600;
        font-size: 14px;
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .nh-logo {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .nh-close {
        background: none;
        border: none;
        cursor: pointer;
        font-size: 18px;
        color: #6b7280;
      }
      .nh-body {
        padding: 12px;
      }
      .nh-status {
        padding: 8px;
        margin-bottom: 10px;
        border-radius: 6px;
        font-size: 12px;
        text-align: center;
      }
      .nh-status.connected {
        background: #ecfdf5;
        color: #047857;
        border: 1px solid #d1fae5;
      }
      .nh-status.disconnected {
        background: #fef2f2;
        color: #dc2626;
        border: 1px solid #fee2e2;
      }
      .nh-section {
        margin-bottom: 12px;
      }
      .nh-label {
        font-size: 11px;
        font-weight: 600;
        color: #6b7280;
        text-transform: uppercase;
        margin-bottom: 4px;
      }
      .nh-value {
        font-size: 13px;
        color: #1f2937;
        word-break: break-all;
        padding: 4px;
        background: #f9fafb;
        border-radius: 4px;
      }
      .nh-button {
        width: 100%;
        padding: 8px;
        margin-top: 8px;
        border: none;
        border-radius: 4px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        transition: opacity 0.2s;
      }
      .nh-button.primary {
        background: #0ea5e9;
        color: white;
      }
      .nh-button.primary:hover {
        opacity: 0.9;
      }
      .nh-button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .nh-log {
        font-size: 11px;
        color: #6b7280;
        max-height: 100px;
        overflow-y: auto;
        padding: 6px;
        background: #f3f4f6;
        border-radius: 4px;
        margin-top: 8px;
      }
      .nh-log-entry {
        margin: 2px 0;
        word-break: break-word;
      }
    </style>
    <div class="nh-header">
      <div class="nh-logo">
        <span>🎯 NeetHub</span>
      </div>
      <button class="nh-close" id="nh-close">✕</button>
    </div>
    <div class="nh-body">
      <div class="nh-status disconnected" id="nh-status">Not Authorized</div>
      
      <div class="nh-section">
        <div class="nh-label">Repository</div>
        <div class="nh-value" id="nh-repo">Not configured</div>
      </div>

      <div class="nh-section">
        <div class="nh-label">Auto-upload</div>
        <div class="nh-value" id="nh-auto">—</div>
      </div>

      <button class="nh-button primary" id="nh-push-btn" disabled>Push to GitHub</button>
      <button class="nh-button primary" id="nh-settings-btn" style="margin-top: 4px;">Settings</button>

      <div class="nh-log" id="nh-log"></div>
    </div>
  `;

  document.body.appendChild(panel);
  updatePanel();
}

function setupPanelListeners() {
  const closeBtn = document.querySelector<HTMLButtonElement>('#nh-close');
  const settingsBtn = document.querySelector<HTMLButtonElement>('#nh-settings-btn');
  const pushBtn = document.querySelector<HTMLButtonElement>('#nh-push-btn');

  closeBtn?.addEventListener('click', () => {
    const panel = document.querySelector('#neethub-panel') as HTMLElement | null;
    if (panel) panel.style.display = 'none';
  });

  settingsBtn?.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  pushBtn?.addEventListener('click', async () => {
    // For testing: capture current page code if available
    const code = extractPageCode();
    if (!code) {
      logPanel('No code found on page');
      return;
    }

    const submission: SubmissionPayload = {
      title: extractPageTitle() || 'Unknown Problem',
      slug: (extractPageSlug() || 'unknown').toLowerCase().replace(/\s+/g, '-'),
      language: 'javascript',
      code,
      runtime: 'n/a',
      memory: 'n/a',
      timestamp: Date.now(),
    };

    pushBtn.disabled = true;
    logPanel('Pushing...');
    await pushSubmission(submission, 'manual');
    pushBtn.disabled = false;
  });

  // Refresh panel every 2 seconds
  setInterval(updatePanel, 2000);
}

async function updatePanel() {
  const settings = (await chrome.runtime.sendMessage({ type: 'get-settings' })) as Settings;

  const statusEl = document.querySelector('#nh-status') as HTMLElement | null;
  const repoEl = document.querySelector('#nh-repo') as HTMLElement | null;
  const autoEl = document.querySelector('#nh-auto') as HTMLElement | null;
  const pushBtn = document.querySelector<HTMLButtonElement>('#nh-push-btn');

  if (statusEl) {
    const isConnected = !!settings.auth?.accessToken;
    statusEl.className = `nh-status ${isConnected ? 'connected' : 'disconnected'}`;
    statusEl.innerText = isConnected ? '✓ Connected to GitHub' : '✗ Not Authorized';
  }

  if (repoEl) {
    repoEl.innerText = settings.repo
      ? `${settings.repo.owner}/${settings.repo.name}`
      : 'Not configured';
  }

  if (autoEl) {
    autoEl.innerText = settings.uploadEnabled ? 'Enabled' : 'Disabled';
  }

  if (pushBtn) {
    pushBtn.disabled = !settings.auth?.accessToken || !settings.repo;
  }
}

function logPanel(message: string) {
  const logEl = document.querySelector('#nh-log');
  if (!logEl) return;

  const entry = document.createElement('div');
  entry.className = 'nh-log-entry';
  entry.innerText = `[${new Date().toLocaleTimeString()}] ${message}`;
  logEl.appendChild(entry);

  // Keep only last 5 entries
  while (logEl.children.length > 5) {
    logEl.removeChild(logEl.children[0]);
  }

  logEl.scrollTop = logEl.scrollHeight;
}

// Lightweight on-screen badge for success/failure feedback
const BADGE_ID = 'neethub-badge';
let badgeHideTimer: number | undefined;

function ensureBadge(): HTMLElement {
  let badge = document.getElementById(BADGE_ID) as HTMLElement | null;
  if (!badge) {
    badge = document.createElement('div');
    badge.id = BADGE_ID;
    badge.setAttribute('aria-live', 'polite');
    const style = badge.style;
    style.position = 'fixed';
    style.top = '20px';
    style.right = '20px';
    style.width = '28px';
    style.height = '28px';
    style.borderRadius = '14px';
    style.display = 'flex';
    style.alignItems = 'center';
    style.justifyContent = 'center';
    style.color = '#fff';
    style.fontSize = '16px';
    style.fontWeight = '700';
    style.boxShadow = '0 2px 8px rgba(0,0,0,0.15)';
    style.zIndex = '9999';
    style.transition = 'opacity 0.2s';
    style.opacity = '0';
    document.body.appendChild(badge);
  }
  return badge!;
}

function showBadge(state: 'pending' | 'success' | 'error') {
  const badge = ensureBadge();
  const style = badge.style;
  if (badgeHideTimer) {
    window.clearTimeout(badgeHideTimer);
    badgeHideTimer = undefined;
  }
  if (state === 'pending') {
    style.background = '#f59e0b'; // amber
    badge.textContent = '…';
  } else if (state === 'success') {
    style.background = '#16a34a'; // green
    badge.textContent = '✓';
  } else {
    style.background = '#dc2626'; // red
    badge.textContent = '✗';
  }
  style.opacity = '1';
  const delay = state === 'pending' ? 1200 : 2500;
  badgeHideTimer = window.setTimeout(() => {
    style.opacity = '0';
  }, delay);
}

function extractPageTitle(): string | undefined {
  // Try common selectors for problem title
  const selectors = [
    'h1',
    '[data-test*="title"]',
    '.problem-title',
    '.question-title',
  ];

  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el.textContent?.trim();
  }

  return undefined;
}

function extractPageSlug(): string | undefined {
  // Try to extract from URL
  const match = window.location.pathname.match(/\/problems?\/([a-z0-9\-]+)/i);
  return match?.[1];
}

function extractPageLanguage(): string | undefined {
  // Try common elements showing selected language
  const candidates = [
    '.language-select',
    '[data-selected-language]',
    '[aria-label*="language"]',
    '.editor-toolbar',
  ];
  for (const sel of candidates) {
    const el = document.querySelector(sel);
    const text = el?.textContent?.toLowerCase() ?? '';
    if (text.includes('java')) return 'java';
    if (text.includes('python')) return 'python';
    if (text.includes('c++')) return 'cpp';
    if (text.includes('javascript')) return 'javascript';
    if (text.includes('typescript')) return 'typescript';
  }

  // Broad fallback: inspect small set of languages in body text
  const bodyText = document.body?.innerText?.toLowerCase() ?? '';
  if (bodyText.includes('code | java')) return 'java';
  if (bodyText.includes('code | python')) return 'python';
  if (bodyText.includes('code | c++')) return 'cpp';
  if (bodyText.includes('code | javascript')) return 'javascript';
  if (bodyText.includes('code | typescript')) return 'typescript';

  return undefined;
}

function extractPageCode(): string | undefined {
  // Try common code editor selectors
  const selectors = [
    '.monaco-editor',
    '[class*="editor"]',
    'textarea',
    'pre',
  ];

  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) {
      const text = el.textContent?.trim();
      if (text && text.length > 10) return text;
    }
  }

  // Fallback: try reading Monaco model via injected script
  try {
    const code = (window as any).monaco?.editor?.getModels?.()[0]?.getValue?.();
    if (typeof code === 'string' && code.trim().length > 10) return code.trim();
  } catch {}

  return undefined;
}

function patchFetch() {
  const original = window.fetch;
  window.fetch = async (...args) => {
    const response = await original(...args);
    const url = getUrl(args[0]);
    const init = (args[1] as RequestInit | undefined);
    tryCaptureFromResponse(response.clone(), url, init);
    return response;
  };
}

function patchXhr() {
  const OriginalXHR = window.XMLHttpRequest;
  class WrappedXHR extends OriginalXHR {
    private _url = '';
    private _reqData: unknown = undefined;

    open(method: string, url: string | URL, async?: boolean, username?: string) {
      this._url = typeof url === 'string' ? url : url.toString();
      return super.open(method, url as any, async, username);
    }

    send(body?: Document | BodyInit | null) {
      // Capture request body for pairing with response
      try {
        if (typeof body === 'string') {
          try {
            this._reqData = JSON.parse(body);
          } catch {
            this._reqData = body;
          }
        } else {
          this._reqData = body ?? undefined;
        }
      } catch {}

      this.addEventListener('loadend', () => {
        if (!this.responseType || this.responseType === 'text') {
          tryCaptureFromText(this.responseText, this._url, this._reqData);
        }
      });
      return super.send(body as Parameters<XMLHttpRequest['send']>[0]);
    }
  }

  window.XMLHttpRequest = WrappedXHR as typeof XMLHttpRequest;
}

async function tryCaptureFromResponse(response: Response, url?: string, init?: RequestInit) {
  if (!urlLooksLikeSubmission(url)) return;
  try {
    const data = await response.json();
    let requestBody: unknown = undefined;
    if (init?.body) {
      try {
        requestBody = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
      } catch {}
    }
    debugCapture(url ?? '', requestBody, data);
    handleCandidate(data, url ?? '', requestBody);
  } catch (err) {
    warn('NeetHub: failed to parse response json', err);
  }
}

function tryCaptureFromText(text: string, url?: string, requestData?: unknown) {
  if (!urlLooksLikeSubmission(url)) return;
  try {
    const data = JSON.parse(text);
    debugCapture(url ?? '', requestData, data);
    handleCandidate(data, url ?? '', requestData);
  } catch (err) {
    // ignore non-JSON
  }
}

function handleCandidate(data: unknown, source: string, requestData?: unknown) {
  const payload = extractSubmission(data, requestData);
  if (!payload) return;

  if (isRecent(payload)) {
    log('NeetHub: duplicate submission skipped');
    return;
  }

  void pushSubmission(payload, source);
}

async function pushSubmission(payload: SubmissionPayload, source: string) {
  try {
    showBadge('pending');
    const response = await chrome.runtime.sendMessage({ type: 'submission', payload });
    if (response?.ok) {
      markRecent(payload);
      logPanel(`✓ Pushed: ${payload.title}`);
      log('Submission sent to background from', source);
      showBadge('success');
    } else {
      logPanel(`✗ Push failed: ${response?.error ?? 'unknown'}`);
      warn('Submission failed', response?.error);
      showBadge('error');
    }
  } catch (err) {
    logPanel(`✗ Error: ${err instanceof Error ? err.message : String(err)}`);
    warn('Failed to send submission', err);
    showBadge('error');
  }
}

function extractSubmission(data: unknown, requestData?: unknown): SubmissionPayload | undefined {
  if (!data || typeof data !== 'object') return undefined;

  const root = data as Record<string, unknown>;
  
  // Extract request data if available (applies to both endpoints)
  let code: string | undefined;
  let lang: string | undefined;
  let problemId: string | undefined;

  if (requestData && typeof requestData === 'object') {
    const req = requestData as Record<string, unknown>;
    code = getString(req, ['rawCode', 'code', 'solution', 'answer']);
    lang = getString(req, ['lang', 'language', 'langSlug']);
    problemId = getString(req, ['problemId', 'slug', 'titleSlug', 'questionSlug']);
  }

  // Handle executeCodeFunctionHttp: data is a single object
  const singleResult = root.data as Record<string, unknown> | undefined;
  if (singleResult && typeof singleResult === 'object' && !Array.isArray(singleResult)) {
    const status = singleResult.status as Record<string, unknown> | undefined;
    const desc = status?.description as string | undefined;

    // Only proceed if accepted or we have code from request
    if (desc?.toLowerCase() === 'accepted' || code) {
      const runtime = getMetric(singleResult, ['time', 'wall_time']);
      const memory = getMetric(singleResult, ['memory']);
      const ts = getTimestamp(singleResult, ['finished_at', 'created_at']);

      if (code && lang) {
        return {
          title: extractPageTitle() || problemId || 'Unknown Problem',
          slug: (problemId || extractPageSlug() || 'unknown').toLowerCase().replace(/\s+/g, '-'),
          language: lang,
          code,
          runtime: runtime ?? 'n/a',
          memory: memory ?? 'n/a',
          timestamp: ts ?? Date.now(),
        };
      }
    }
  }

  // Handle runCodeFunctionHttp: data is an array of results
  const arr = Array.isArray(root.data) ? (root.data as Array<Record<string, unknown>>) : undefined;
  if (arr && arr.length) {
    // Prefer the last accepted item
    const accepted = [...arr].reverse().find((item) => {
      const status = item.status as Record<string, unknown> | undefined;
      const desc = status?.description as string | undefined;
      return desc?.toLowerCase() === 'accepted';
    }) ?? arr[arr.length - 1];

    const runtime = getMetric(accepted, ['time', 'wall_time']);
    const memory = getMetric(accepted, ['memory']);
    const ts = getTimestamp(accepted, ['finished_at', 'created_at']);

    // Use request code if available, otherwise fallback to page extraction
    const finalCode = code ?? extractPageCode();
    const finalLang = lang ?? extractPageLanguage() ?? 'unknown';

    if (finalCode) {
      return {
        title: extractPageTitle() || problemId || 'Unknown Problem',
        slug: (problemId || extractPageSlug() || 'unknown').toLowerCase().replace(/\s+/g, '-'),
        language: finalLang,
        code: finalCode,
        runtime: runtime ?? 'n/a',
        memory: memory ?? 'n/a',
        timestamp: ts ?? Date.now(),
      };
    }
  }

  // Fallback: generic BFS for other shapes
  const queue: unknown[] = [data];
  let steps = 0;

  while (queue.length && steps < 200) {
    steps += 1;
    const current = queue.shift();
    if (!current || typeof current !== 'object') continue;
    const candidate = current as Record<string, unknown>;

    const cCode = getString(candidate, ['code', 'solution', 'answer']);
    const cLang = getString(candidate, ['lang', 'language', 'langSlug']);
    const cTitle = getString(candidate, ['title', 'questionTitle', 'problemTitle']);
    const cSlug = getString(candidate, ['slug', 'titleSlug', 'questionSlug', 'problemSlug']);
    const cRuntime = getMetric(candidate, ['runtime', 'runTime', 'time']);
    const cMemory = getMetric(candidate, ['memory', 'mem']);
    const cTs = getTimestamp(candidate, ['timestamp', 'createdAt', 'submittedAt']);

    if (cCode && (cTitle || cSlug) && cLang) {
      return {
        title: cTitle ?? cSlug ?? 'Unknown Problem',
        slug: (cSlug ?? cTitle ?? 'unknown').toLowerCase().replace(/\s+/g, '-'),
        language: cLang,
        code: cCode,
        runtime: cRuntime ?? 'n/a',
        memory: cMemory ?? 'n/a',
        timestamp: cTs ?? Date.now(),
      };
    }

    // breadth-first search nested objects/arrays
    Object.values(candidate).forEach((value) => {
      if (value && typeof value === 'object') {
        queue.push(value);
      }
    });
  }

  return undefined;
}

function getString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === 'string' && val.trim()) return val;
  }
  return undefined;
}

function getMetric(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === 'string' && val) return val;
    if (typeof val === 'number') return `${val}`;
  }
  return undefined;
}

function getTimestamp(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === 'number') return val > 10_000_000_000 ? val : val * 1000; // seconds vs ms
    if (typeof val === 'string') {
      const parsed = Date.parse(val);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return undefined;
}

// Deprecated; replaced by urlLooksLikeSubmission
function isLikelySubmissionUrl(url?: string): boolean {
  return urlLooksLikeSubmission(url);
}

function getUrl(input: RequestInfo | URL): string | undefined {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  if (input && typeof input === 'object' && 'url' in input) return (input as Request).url;
  return undefined;
}

function isRecent(payload: SubmissionPayload): boolean {
  const key = buildKey(payload);
  return recentKeys.has(key);
}

function markRecent(payload: SubmissionPayload) {
  const key = buildKey(payload);
  recentKeys.add(key);
  setTimeout(() => recentKeys.delete(key), RECENT_TTL_MS);
}

function buildKey(payload: SubmissionPayload): string {
  return `${payload.slug}-${hash(payload.code)}`;
}

function hash(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) {
    h = (h << 5) - h + text.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString(36);
}
