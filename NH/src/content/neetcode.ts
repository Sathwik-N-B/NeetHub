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
    // Inject toolbar button (inline in editor area)
    injectToolbarButton();

    // Listen for Submit button clicks
    attachSubmitButtonListener();

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

let isMonitoringSubmission = false;

function attachSubmitButtonListener() {
  // Use event delegation on document body to catch Submit button clicks
  document.body.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    
    // Check if clicked element or its parent is the Submit button
    const submitButton = target.closest('button[type="submit"], button.is-success, .submit-button, button');

    if (!submitButton) return;

    // Verify by text content to avoid false positives
    const text = submitButton.textContent?.trim().toLowerCase();
    if (text === 'submit') {
      log('Submit button clicked');
      startMonitoringForAcceptance();
    }
  }, true); // Use capture phase to catch early
}

function startMonitoringForAcceptance() {
  if (isMonitoringSubmission) {
    log('Already monitoring a submission');
    return;
  }
  
  isMonitoringSubmission = true;
  log('Started monitoring for accepted submission result...');
  
  // Poll for accepted result for up to 30 seconds
  let attempts = 0;
  const maxAttempts = 60; // 60 * 500ms = 30 seconds
  
  const checkInterval = setInterval(() => {
    attempts++;
    
    if (attempts > maxAttempts) {
      clearInterval(checkInterval);
      isMonitoringSubmission = false;
      log('Stopped monitoring: timeout reached');
      return;
    }
    
    // Check if page shows accepted
    if (isPageShowingAcceptedSubmission()) {
      clearInterval(checkInterval);
      isMonitoringSubmission = false;
      
      log('Accepted submission detected! Auto-triggering push...');
      
      // Wait a bit for page to fully update, then trigger push
      setTimeout(() => {
        autoTriggerPush();
      }, 1000);
    }
  }, 500);
}

function autoTriggerPush() {
  // Extract submission data from page
  const code = extractPageCode();
  if (!code) {
    warn('Cannot auto-push: no code found');
    return;
  }
  
  const submission: SubmissionPayload = {
    title: extractPageTitle() || 'Unknown Problem',
    slug: (extractPageSlug() || 'unknown').toLowerCase().replace(/\s+/g, '-'),
    language: extractPageLanguage() || 'unknown',
    code,
    runtime: 'auto',
    memory: 'auto',
    timestamp: Date.now(),
  };
  
  // Store as last accepted submission
  lastAcceptedSubmission = submission;
  
  // Check for duplicates
  if (isRecent(submission)) {
    log('Auto-push skipped: duplicate submission');
    return;
  }
  
  log('Auto-triggering push for:', submission.title);
  void pushSubmission(submission, 'auto-trigger', true);
}

// NeetCode endpoints observed in DevTools
// Only 'submit' and 'submission' are actual submission endpoints
// 'runCode' and 'executeCode' are for testing, not submissions
const SUBMISSION_ENDPOINT_HINTS = [
  'submission',
  'submit',
];

const RUN_CODE_ENDPOINT_HINTS = [
  'runcode',
  'executecode',
];

function urlLooksLikeSubmission(url?: string): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  
  // Exclude run code endpoints
  if (RUN_CODE_ENDPOINT_HINTS.some((hint) => lower.includes(hint))) {
    log('Excluded run code endpoint:', url);
    return false;
  }
  
  // Only match actual submission endpoints
  const isSubmission = SUBMISSION_ENDPOINT_HINTS.some((hint) => lower.includes(hint)) && lower.includes('neetcode');
  if (isSubmission) {
    log('Detected submission endpoint:', url);
  }
  return isSubmission;
}

function debugCapture(url: string, requestBody: unknown, responseData: unknown) {
  try {
    console.group('[NeetHub] Captured NeetCode API');
    console.info('URL:', url);
    console.info('Request body:', requestBody);
    console.info('Response:', responseData);
    
    // Log acceptance detection
    if (responseData && typeof responseData === 'object') {
      const root = responseData as Record<string, unknown>;
      const data = root.data;
      if (data && typeof data === 'object') {
        const single = data as Record<string, unknown>;
        const status = single.status as Record<string, unknown> | undefined;
        if (status?.description) {
          console.info('Status description:', status.description);
        }
      }
    }
    
    console.groupEnd();
  } catch {}
}

// Track last submission for retry
let lastFailedSubmission: SubmissionPayload | null = null;
let lastAcceptedSubmission: SubmissionPayload | null = null; // Track last accepted submission
let toolbarButtonState: 'idle' | 'pushing' | 'success' | 'error' = 'idle';

function injectToolbarButton() {
  // Wait a bit for the page to fully render, then keep trying
  const tryInject = () => {
    if (!document.getElementById('neethub-toolbar-btn')) {
      attemptToolbarInjection();
    }
  };
  
  // Try immediately, then after delays
  tryInject();
  setTimeout(tryInject, 1000);
  setTimeout(tryInject, 2000);
  setTimeout(tryInject, 4000);
  
  // Also try on any DOM changes (for SPA navigation)
  const observer = new MutationObserver(() => {
    if (!document.getElementById('neethub-toolbar-btn')) {
      attemptToolbarInjection();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function attemptToolbarInjection() {
  // Check if already injected
  if (document.getElementById('neethub-toolbar-btn')) {
    return;
  }

  log('Attempting toolbar injection...');

  // Debug: Log all elements with data-tooltip
  const allTooltips = document.querySelectorAll('[data-tooltip]');
  if (allTooltips.length > 0) {
    log('Found elements with data-tooltip:', Array.from(allTooltips).map(el => ({
      tooltip: el.getAttribute('data-tooltip'),
      tagName: el.tagName,
      href: el.getAttribute('href'),
      classes: el.className
    })));
  }

  // Find the Notes button - try multiple selectors
  let notesBtn = document.querySelector('[data-tooltip="Notes"]');
  
  if (!notesBtn) {
    // Try href-based selectors
    notesBtn = document.querySelector('a[href*="/notes"]');
  }
  
  if (!notesBtn) {
    // Try finding by class and href pattern
    notesBtn = document.querySelector('.toolbar-icon-btn[href*="notes"]');
  }

  if (!notesBtn) {
    // Try finding any link with "notes" in the URL on the problem page
    const allLinks = document.querySelectorAll('a[href*="notes"]');
    log('Found links with "notes":', allLinks.length);
    if (allLinks.length > 0) {
      notesBtn = allLinks[0];
    }
  }
  
  if (!notesBtn) {
    log('Notes button not found yet...');
    return;
  }

  log('Found Notes button!', {
    tagName: notesBtn.tagName,
    href: notesBtn.getAttribute('href'),
    classes: notesBtn.className,
    parent: notesBtn.parentElement?.tagName,
    parentClasses: notesBtn.parentElement?.className
  });

  // Create the button
  const container = document.createElement('div');
  container.id = 'neethub-toolbar-btn';
  container.innerHTML = `
    <style>
      #neethub-toolbar-btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        margin-right: 8px;
        padding: 4px 10px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 13px;
        font-weight: 500;
        font-family: inherit;
        transition: all 0.15s ease;
        user-select: none;
        background: transparent;
        border: 1px solid transparent;
      }
      #neethub-toolbar-btn:hover {
        background: rgba(255,255,255,0.1);
      }
      #neethub-toolbar-btn .nh-icon {
        width: 16px;
        height: 16px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 10px;
        font-weight: bold;
        color: white;
        flex-shrink: 0;
      }
      #neethub-toolbar-btn .nh-icon.idle {
        background: #6b7280;
      }
      #neethub-toolbar-btn .nh-icon.pushing {
        background: #f59e0b;
        animation: nh-pulse 1s infinite;
      }
      #neethub-toolbar-btn .nh-icon.success {
        background: #22c55e;
      }
      #neethub-toolbar-btn .nh-icon.error {
        background: #ef4444;
      }
      @keyframes nh-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.5; }
      }
      #neethub-toolbar-btn .nh-text {
        color: #e5e7eb;
        font-size: 12px;
      }
    </style>
    <span class="nh-icon idle" id="nh-tb-icon">✓</span>
    <span class="nh-text" id="nh-tb-text">Push</span>
  `;

  // Insert right before the Notes button
  notesBtn.parentElement?.insertBefore(container, notesBtn);
  log('NeetHub button injected before Notes!');

  const iconEl = document.getElementById('nh-tb-icon')!;
  const textEl = document.getElementById('nh-tb-text')!;

  container.addEventListener('click', async () => {
    if (toolbarButtonState === 'pushing') return;

    // If error state, retry last failed submission
    if (toolbarButtonState === 'error' && lastFailedSubmission) {
      await doToolbarPush(iconEl, textEl, lastFailedSubmission);
      return;
    }

    // Manual push: Check if page shows accepted status OR we have stored accepted submission
    const pageShowsAccepted = isPageShowingAcceptedSubmission();
    const hasStoredAccepted = lastAcceptedSubmission !== null;
    
    if (!pageShowsAccepted && !hasStoredAccepted) {
      iconEl.className = 'nh-icon error';
      iconEl.textContent = '✗';
      textEl.textContent = 'Not accepted';
      setTimeout(() => {
        iconEl.className = 'nh-icon idle';
        iconEl.textContent = '✓';
        textEl.textContent = 'Push';
      }, 2500);
      log('Manual push blocked: no accepted submission found on page');
      return;
    }

    // If we have stored accepted submission, use it
    if (hasStoredAccepted) {
      log('Manual push using stored accepted submission');
      await doToolbarPush(iconEl, textEl, lastAcceptedSubmission!);
      return;
    }

    // Otherwise, extract from current page
    const code = extractPageCode();
    if (!code) {
      iconEl.className = 'nh-icon error';
      iconEl.textContent = '✗';
      textEl.textContent = 'No code';
      setTimeout(() => {
        iconEl.className = 'nh-icon idle';
        iconEl.textContent = '✓';
        textEl.textContent = 'Push';
      }, 2000);
      return;
    }

    const submission: SubmissionPayload = {
      title: extractPageTitle() || 'Unknown Problem',
      slug: (extractPageSlug() || 'unknown').toLowerCase().replace(/\s+/g, '-'),
      language: extractPageLanguage() || 'unknown',
      code,
      runtime: 'manual',
      memory: 'manual',
      timestamp: Date.now(),
    };

    log('Manual push initiated from toolbar with page code');
    await doToolbarPush(iconEl, textEl, submission);
  });
}

async function doToolbarPush(iconEl: HTMLElement, textEl: HTMLElement, submission: SubmissionPayload) {
  // Update UI to pushing state
  toolbarButtonState = 'pushing';
  iconEl.className = 'nh-icon pushing';
  iconEl.textContent = '⋯';
  textEl.textContent = 'Pushing...';

  try {
    const response = await chrome.runtime.sendMessage({ type: 'submission', payload: submission });
    
    if (response?.ok) {
      // Success
      toolbarButtonState = 'success';
      lastFailedSubmission = null;
      iconEl.className = 'nh-icon success';
      iconEl.textContent = '✓';
      textEl.textContent = 'Push';
      
      log('Submission pushed via toolbar:', submission.title);

      // Keep green for a bit, then reset
      setTimeout(() => {
        if (toolbarButtonState === 'success') {
          toolbarButtonState = 'idle';
          iconEl.className = 'nh-icon idle';
        }
      }, 5000);
    } else {
      throw new Error(response?.error || 'Unknown error');
    }
  } catch (err) {
    toolbarButtonState = 'error';
    lastFailedSubmission = submission;
    iconEl.className = 'nh-icon error';
    iconEl.textContent = '✗';
    textEl.textContent = 'Retry';
    
    warn('Toolbar push failed:', err);
  }
}

// Update toolbar status from other push sources (auto-capture, panel)
function updateToolbarStatus(state: 'pushing' | 'success' | 'error', message?: string) {
  const iconEl = document.getElementById('nh-tb-icon');
  const textEl = document.getElementById('nh-tb-text');
  
  if (!iconEl || !textEl) return;

  toolbarButtonState = state;
  
  if (state === 'pushing') {
    iconEl.className = 'nh-icon pushing';
    iconEl.textContent = '⋯';
    textEl.textContent = 'Pushing...';
  } else if (state === 'success') {
    iconEl.className = 'nh-icon success';
    iconEl.textContent = '✓';
    textEl.textContent = 'Push';
    
    setTimeout(() => {
      if (toolbarButtonState === 'success') {
        toolbarButtonState = 'idle';
        iconEl.className = 'nh-icon idle';
      }
    }, 5000);
  } else if (state === 'error') {
    iconEl.className = 'nh-icon error';
    iconEl.textContent = '✗';
    textEl.textContent = 'Retry';
  }
}


// Lightweight on-screen badge for success/failure feedback (hidden, kept for compatibility)
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

function isPageShowingAcceptedSubmission(): boolean {
  // Check for CURRENT submission result showing "Accepted" - be very specific
  
  // Method 1: Look for green "Accepted" text in the test results area
  const acceptedElements = document.querySelectorAll('*');
  for (const el of acceptedElements) {
    const text = el.textContent?.trim();
    // Only check elements with exactly "Accepted" and green color styling
    if (text === 'Accepted') {
      const color = window.getComputedStyle(el).color;
      // Green text indicates accepted (rgb values for green)
      if (color.includes('34, 197') || color.includes('22, 197') || color.includes('0, 255, 0') || color.includes('green')) {
        log('Found green "Accepted" text indicator');
        return true;
      }
    }
  }
  
  // Method 2: Check for "Passed test cases: X / X" where both numbers match
  const passedText = document.body?.innerText || '';
  const passedMatch = passedText.match(/Passed test cases:\s*(\d+)\s*\/\s*(\d+)/);
  if (passedMatch) {
    const passed = parseInt(passedMatch[1]);
    const total = parseInt(passedMatch[2]);
    if (passed > 0 && passed === total) {
      log('Found matching passed test cases:', passed, '/', total);
      return true;
    }
  }
  
  // Method 3: Check submissions page for "Accepted" with test case count
  if (window.location.pathname.includes('/submissions')) {
    const hasAccepted = passedText.includes('Accepted');
    const hasTestCases = /\d+\s*\/\s*\d+\s*test cases/.test(passedText);
    if (hasAccepted && hasTestCases) {
      log('Submissions page shows accepted solution');
      return true;
    }
  }
  
  log('No accepted submission status found on page');
  return false;
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
  const result = extractSubmission(data, requestData);
  if (!result) return;

  const { payload, isAccepted } = result;

  // Auto-capture only pushes ACCEPTED submissions
  if (!isAccepted) {
    log('NeetHub: submission not accepted, skipping auto-push');
    return;
  }

  if (isRecent(payload)) {
    log('NeetHub: duplicate submission skipped');
    return;
  }

  // Store last accepted submission for manual push button
  lastAcceptedSubmission = payload;

  log('NeetHub: accepted submission detected, auto-pushing...');
  void pushSubmission(payload, source, true); // true = auto-triggered
}

async function pushSubmission(payload: SubmissionPayload, source: string, autoTriggered = false) {
  // Skip toolbar status update if this came from the toolbar itself (it handles its own UI)
  const updateToolbar = source !== 'toolbar';
  
  try {
    showBadge('pending');
    if (updateToolbar) updateToolbarStatus('pushing');
    
    const response = await chrome.runtime.sendMessage({ type: 'submission', payload });
    if (response?.ok) {
      markRecent(payload);
      log('Submission sent to background from', source, payload.title);
      showBadge('success');
      if (updateToolbar) {
        updateToolbarStatus('success', `Pushed: ${payload.title}`);
        if (autoTriggered) {
          log('Auto-push completed, toolbar button updated');
        }
      }
    } else {
      const errorMsg = response?.error ?? 'unknown';
      warn('Submission failed:', response?.error);
      showBadge('error');
      if (updateToolbar) {
        lastFailedSubmission = payload;
        updateToolbarStatus('error', `Failed: ${errorMsg}`);
      }
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    warn('Failed to send submission:', err);
    showBadge('error');
    if (updateToolbar) {
      lastFailedSubmission = payload;
      updateToolbarStatus('error', `Error: ${errorMsg}`);
    }
  }
}

type SubmissionExtractionResult = {
  payload: SubmissionPayload;
  isAccepted: boolean;
};

function extractSubmission(data: unknown, requestData?: unknown): SubmissionExtractionResult | undefined {
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

  // Check for accepted status in the response
  let isAccepted = false;

  // Handle submission response: data is a single object or has status
  const singleResult = root.data as Record<string, unknown> | undefined;
  if (singleResult && typeof singleResult === 'object' && !Array.isArray(singleResult)) {
    const status = singleResult.status as Record<string, unknown> | undefined;
    const desc = status?.description as string | undefined;
    
    // Check if this submission was ACCEPTED
    isAccepted = desc?.toLowerCase() === 'accepted';

    // Only extract if we have code and it's accepted
    if (isAccepted && code && lang) {
      const runtime = getMetric(singleResult, ['time', 'wall_time']);
      const memory = getMetric(singleResult, ['memory']);
      const ts = getTimestamp(singleResult, ['finished_at', 'created_at']);

      return {
        payload: {
          title: extractPageTitle() || problemId || 'Unknown Problem',
          slug: (problemId || extractPageSlug() || 'unknown').toLowerCase().replace(/\s+/g, '-'),
          language: lang,
          code,
          runtime: runtime ?? 'n/a',
          memory: memory ?? 'n/a',
          timestamp: ts ?? Date.now(),
        },
        isAccepted: true,
      };
    }
  }

  // Handle array response: data is an array of results
  const arr = Array.isArray(root.data) ? (root.data as Array<Record<string, unknown>>) : undefined;
  if (arr && arr.length) {
    // Check if ANY result is accepted
    const acceptedItem = [...arr].reverse().find((item) => {
      const status = item.status as Record<string, unknown> | undefined;
      const desc = status?.description as string | undefined;
      return desc?.toLowerCase() === 'accepted';
    });

    isAccepted = !!acceptedItem;

    if (isAccepted && acceptedItem) {
      const runtime = getMetric(acceptedItem, ['time', 'wall_time']);
      const memory = getMetric(acceptedItem, ['memory']);
      const ts = getTimestamp(acceptedItem, ['finished_at', 'created_at']);

      const finalCode = code ?? extractPageCode();
      const finalLang = lang ?? extractPageLanguage() ?? 'unknown';

      if (finalCode) {
        return {
          payload: {
            title: extractPageTitle() || problemId || 'Unknown Problem',
            slug: (problemId || extractPageSlug() || 'unknown').toLowerCase().replace(/\s+/g, '-'),
            language: finalLang,
            code: finalCode,
            runtime: runtime ?? 'n/a',
            memory: memory ?? 'n/a',
            timestamp: ts ?? Date.now(),
          },
          isAccepted: true,
        };
      }
    }
  }

  // Fallback: generic BFS for other shapes (still check for accepted status)
  const queue: unknown[] = [data];
  let steps = 0;
  let foundAccepted = false;

  while (queue.length && steps < 200) {
    steps += 1;
    const current = queue.shift();
    if (!current || typeof current !== 'object') continue;
    const candidate = current as Record<string, unknown>;

    // Check for accepted status
    const statusDesc = getString(candidate, ['status', 'statusDescription', 'description']);
    if (statusDesc?.toLowerCase() === 'accepted') {
      foundAccepted = true;
    }

    const cCode = getString(candidate, ['code', 'solution', 'answer']);
    const cLang = getString(candidate, ['lang', 'language', 'langSlug']);
    const cTitle = getString(candidate, ['title', 'questionTitle', 'problemTitle']);
    const cSlug = getString(candidate, ['slug', 'titleSlug', 'questionSlug', 'problemSlug']);
    const cRuntime = getMetric(candidate, ['runtime', 'runTime', 'time']);
    const cMemory = getMetric(candidate, ['memory', 'mem']);
    const cTs = getTimestamp(candidate, ['timestamp', 'createdAt', 'submittedAt']);

    if (cCode && (cTitle || cSlug) && cLang && foundAccepted) {
      return {
        payload: {
          title: cTitle ?? cSlug ?? 'Unknown Problem',
          slug: (cSlug ?? cTitle ?? 'unknown').toLowerCase().replace(/\s+/g, '-'),
          language: cLang,
          code: cCode,
          runtime: cRuntime ?? 'n/a',
          memory: cMemory ?? 'n/a',
          timestamp: cTs ?? Date.now(),
        },
        isAccepted: true,
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
