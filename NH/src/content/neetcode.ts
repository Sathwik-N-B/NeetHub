import type { SubmissionPayload } from '../lib/github';
import type { Settings } from '../lib/storage';

// Inline logger functions to avoid import issues in content script
function log(...args: unknown[]) {
  console.log('[NeetHub]', ...args);
}

function warn(...args: unknown[]) {
  console.warn('[NeetHub]', ...args);
}

// Helper to check nested properties in objects
function hasProperty(obj: unknown, path: string[]): boolean {
  if (!obj || typeof obj !== 'object') return false;
  let current: any = obj;
  for (const key of path) {
    if (!current || typeof current !== 'object' || !(key in current)) {
      return false;
    }
    current = current[key];
  }
  return current !== undefined && current !== null;
}

// Track last submission for retry - MUST be declared before any function that uses them
let recentKeys = new Set<string>();
const RECENT_TTL_MS = 10 * 60 * 1000; // dedupe window

let isMonitoringSubmission = false;
let lastFailedSubmission: SubmissionPayload | null = null;
let lastAcceptedSubmission: SubmissionPayload | null = null; // Track last accepted submission
let currentProblemSlug: string | null = null; // Track current problem to reset state on navigation
let toolbarButtonState: 'idle' | 'pushing' | 'success' | 'error' = 'idle';
let lastRequestLanguage: string | undefined; // Capture language from API request

// Ensure DOM is ready before injecting
function initializeExtension() {
  try {
    // Inject toolbar button (inline in editor area)
    injectToolbarButton();

    // Listen for Submit button clicks
    attachSubmitButtonListener();

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
  if (!data || data.source !== 'neetcode') return;

  if (data.type !== 'submission') return;

  const payload = data.payload as SubmissionPayload;
  if (!payload?.code) {
    warn('NeetHub: submission payload missing code');
    return;
  }

  void pushSubmissionWithEnrichment(payload, 'postMessage');
});

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
        void autoTriggerPush();
      }, 1000);
    }
  }, 500);
}

async function autoTriggerPush() {
  // Extract submission data from page
  const code = extractPageCode();
  if (!code) {
    warn('Cannot auto-push: no code found');
    return;
  }

  log('DEBUG: Code extracted, length:', code.length, 'first 100 chars:', code.substring(0, 100));

  const rawSlug = extractPageSlug();
  const slug = rawSlug ? rawSlug.toLowerCase().replace(/\s+/g, '-') : 'unknown';
  const url = buildProblemUrl(slug);

  // Use captured language from request, otherwise fallback to page extraction or code detection
  const pageLang = extractPageLanguage();
  const codeLang = detectLanguageFromCode(code);
  
  let language = lastRequestLanguage || pageLang || codeLang || 'unknown';
  log('NeetHub: Auto-trigger using language:', language);

  const submission: SubmissionPayload = {
    title: extractPageTitle() || 'Unknown Problem',
    slug,
    language,
    code,
    runtime: 'auto',
    memory: 'auto',
    timestamp: Date.now(),
    url,
    problemNumber: extractPageNumber(),
    difficulty: extractDifficulty(),
    description: extractProblemDescription(),
  };

  // Check for duplicates
  if (isRecent(submission)) {
    log('Auto-push skipped: duplicate submission');
    return;
  }

  const enrichedSubmission = await enrichSubmissionPayload(submission);
  lastAcceptedSubmission = enrichedSubmission;

  log('Auto-triggering push for:', enrichedSubmission.title, 'Language:', enrichedSubmission.language);
  void pushSubmission(enrichedSubmission, 'auto-trigger', true);
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

function checkAndResetProblemState() {
  const currentSlug = extractPageSlug();
  if (currentSlug && currentSlug !== currentProblemSlug) {
    // Problem changed - reset state
    log('Problem changed from', currentProblemSlug, 'to', currentSlug, '- resetting state');
    currentProblemSlug = currentSlug;
    lastAcceptedSubmission = null;
    lastFailedSubmission = null;
    isMonitoringSubmission = false;
  } else if (currentSlug && !currentProblemSlug) {
    // First problem load
    currentProblemSlug = currentSlug;
  }
}

function attemptToolbarInjection() {
  // Check if already injected
  if (document.getElementById('neethub-toolbar-btn')) {
    return;
  }
  
  // Check if problem changed and reset state if needed
  checkAndResetProblemState();

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

    // Check if problem changed and reset state if needed
    checkAndResetProblemState();

    // If error state, retry last failed submission
    if (toolbarButtonState === 'error' && lastFailedSubmission) {
      await doToolbarPush(iconEl, textEl, lastFailedSubmission);
      return;
    }

    // Manual push: ONLY allow if we have accepted submission from auto-trigger for THIS problem
    const currentSlug = extractPageSlug();
    
    // Check if we have accepted submission from THIS session AND it matches current problem
    const hasSessionAccepted = lastAcceptedSubmission !== null && 
                                currentSlug && 
                                lastAcceptedSubmission.slug === currentSlug.toLowerCase().replace(/\s+/g, '-');
    
    if (!hasSessionAccepted) {
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

    // Use accepted submission from current session for THIS problem
    log('Manual push using stored accepted submission');
    await doToolbarPush(iconEl, textEl, lastAcceptedSubmission!);
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
  // Try common selectors for problem title on NeetCode
  const selectors = [
    'app-prompt h1',
    'app-prompt [class*="title"]',
    'app-article h1',
    'h1',
    '[data-test*="title"]',
    '.problem-title',
    '.question-title',
  ];

  for (const sel of selectors) {
    const el = document.querySelector(sel);
    const text = el?.textContent?.trim();
    if (text && text.length > 0) {
      return text;
    }
  }

  return undefined;
}

function extractPageSlug(): string | undefined {
  // Try to extract from URL
  const match = window.location.pathname.match(/\/problems?\/([a-z0-9\-]+)/i);
  return match?.[1];
}

function buildProblemUrl(slug?: string): string | undefined {
  if (!slug) return undefined;
  return `https://neetcode.io/problems/${slug}/question`;
}

async function pushSubmissionWithEnrichment(
  payload: SubmissionPayload,
  source: string,
  autoTriggered = false,
) {
  const enriched = await enrichSubmissionPayload(payload);
  lastAcceptedSubmission = enriched;
  return pushSubmission(enriched, source, autoTriggered);
}

async function enrichSubmissionPayload(payload: SubmissionPayload): Promise<SubmissionPayload> {
  const rawSlug = payload.slug || extractPageSlug() || '';
  const slug = rawSlug.toLowerCase().replace(/\s+/g, '-');
  const url = payload.url || buildProblemUrl(slug);

  let { title, difficulty, description, problemNumber } = payload;
  if (description && isLikelySubmissionDescription(description)) {
    description = undefined;
  }

  // Check if title is a submission status message (not actual problem name)
  const isSubmissionStatus = title && ['accepted', 'rejected', 'pending', 'wrong answer', 'time limit exceeded'].includes(title.toLowerCase());

  if (isSubmissionStatus || !title || !description || !difficulty || !problemNumber) {
    const info = await fetchProblemInfo(slug);
    title = !isSubmissionStatus ? title : info.title;
    title = title || info.title;
    difficulty = difficulty || info.difficulty;
    description = description || info.description;
    problemNumber = problemNumber || info.problemNumber;
  }

  // Fallback: if still no title, format from slug
  if (!title && slug) {
    title = slug
      .split('-')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  return {
    ...payload,
    slug: slug || payload.slug,
    url,
    title: title || payload.title,
    difficulty,
    description,
    problemNumber,
  };
}

function isLikelySubmissionDescription(description: string): boolean {
  const text = description.toLowerCase();
  return text.includes('submission') || text.includes('submitted at') || text.includes('test cases');
}

async function fetchProblemInfo(
  slug?: string,
): Promise<{ title?: string; difficulty?: string; description?: string; problemNumber?: string }> {
  if (!slug) return {};

  const url = buildProblemUrl(slug);
  if (!url) return {};

  try {
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) return {};

    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');

    return {
      title: extractTitleFromDoc(doc),
      difficulty: extractDifficultyFromDoc(doc),
      description: extractDescriptionFromDoc(doc),
      problemNumber: extractNumberFromTitle(extractTitleFromDoc(doc)),
    };
  } catch {
    return {};
  }
}

function extractTitleFromDoc(doc: Document): string | undefined {
  // Try to find the title with problem number (like "1. Two Sum")
  
  // First try: look for title in app-prompt or common heading selectors
  const selectors = [
    'app-prompt h1',
    'app-prompt [class*="title"]',
    'h1',
    '.problem-title',
    '.question-title',
    '[data-test*="title"]',
    'app-article h1',
  ];
  
  for (const sel of selectors) {
    const h1 = doc.querySelector(sel);
    if (h1?.textContent?.trim()) {
      const text = h1.textContent.trim();
      // If it contains a number at the start, keep it; otherwise continue searching
      if (/^\d+\./.test(text)) {
        return text;
      }
    }
  }
  
  // Fallback: try to extract from document title tag
  const titleTag = doc.querySelector('title')?.textContent?.trim();
  if (!titleTag) return undefined;

  let title = titleTag
    .replace(/\s*\|\s*NeetCode.*$/i, '')
    .replace(/\s*-\s*NeetCode.*$/i, '')
    .trim();

  return title || undefined;
}

function extractDifficultyFromDoc(doc: Document): string | undefined {
  const difficulty = doc.querySelector('.difficulty, [data-difficulty]')?.textContent?.trim();
  if (difficulty) return difficulty;

  const text = doc.body?.innerText || '';
  if (text.includes('Easy')) return 'Easy';
  if (text.includes('Medium')) return 'Medium';
  if (text.includes('Hard')) return 'Hard';
  return undefined;
}

function extractDescriptionFromDoc(doc: Document): string | undefined {
  const selectors = [
    'app-article',  // Main problem content container on NeetCode
    '.question-tab .question-content',
    '.question-tab .problem-content',
    '.question-tab .prompt',
    'app-prompt',
    '.question-tab',
  ];

  for (const selector of selectors) {
    let el = doc.querySelector(selector);
    if (!el) continue;
    
    const text = el.textContent?.toLowerCase() ?? '';
    if (text.length < 100) continue;
    if (text.includes('submission') && text.includes('accepted')) continue;
    
    let html = el.innerHTML.trim();
    if (!html || html.length < 100) continue;
    
    return html;
  }

  return undefined;
}

function extractNumberFromTitle(title?: string): string | undefined {
  if (!title) return undefined;
  const match = title.match(/^(\d+)[.\-\s]/);
  return match?.[1];
}

function extractPageNumber(): string | undefined {
  // Try to extract problem number from the title
  const title = extractPageTitle();
  if (!title) return undefined;
  
  // Match patterns like "49. Group Anagrams" or "49 - Group Anagrams"
  const match = title.match(/^(\d+)[.\-\s]/);
  return match?.[1];
}

function extractDifficulty(): string | undefined {
  // Try common selectors for difficulty badge/tag
  const selectors = [
    '[class*="difficulty"]',
    '[class*="Difficulty"]',
    '[data-difficulty]',
    '.badge',
  ];

  for (const sel of selectors) {
    const el = document.querySelector(sel);
    const text = el?.textContent?.trim().toLowerCase();
    if (text === 'easy' || text === 'medium' || text === 'hard') {
      return text.charAt(0).toUpperCase() + text.slice(1);
    }
  }

  // Fallback: search for difficulty in page text
  const bodyText = document.body?.innerText || '';
  if (bodyText.match(/\bEasy\b/)) return 'Easy';
  if (bodyText.match(/\bMedium\b/)) return 'Medium';
  if (bodyText.match(/\bHard\b/)) return 'Hard';

  return undefined;
}

function extractProblemDescription(): string | undefined {
  // Try to extract the full problem description HTML from current page
  const selectors = [
    'app-article',  // Main problem content container on NeetCode
    '[class*="problem-description"]',
    '[class*="question-content"]',
    '[class*="problemDescription"]',
    '.description',
    '[data-cy="question-detail-main-tabs"]',
    'app-prompt',
    '.question-tab',
  ];

  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.innerHTML && el.innerHTML.length > 100) {
      return el.innerHTML;
    }
  }

  return undefined;
}

function isPageShowingAcceptedSubmission(): boolean {
  // Check for CURRENT submission result showing "Accepted" - ONLY after submission
  // Similar to LeetHub's approach, check for success/accepted status
  
  // Method 1: Look for green "Accepted" text or success status element
  const acceptedElements = document.querySelectorAll('*');
  for (const el of acceptedElements) {
    const text = el.textContent?.trim();
    
    // Check for "Accepted" text with green color
    if (text === 'Accepted') {
      const color = window.getComputedStyle(el).color;
      // Green text indicates accepted (rgb values for green)
      if (color.includes('34, 197') || color.includes('22, 197') || color.includes('0, 255, 0') || color.includes('green')) {
        log('Found green "Accepted" text indicator');
        return true;
      }
    }
    
    // Check for success-related classes or data attributes
    const classList = el.className?.toString() || '';
    const dataAttrs = Array.from(el.attributes || [])
      .map(attr => `${attr.name}=${attr.value}`)
      .join(' ');
    
    if ((classList.includes('success') || classList.includes('accepted') || classList.includes('Accepted')) &&
        (text === 'Accepted' || text?.includes('Accepted'))) {
      log('Found success status element with accepted class');
      return true;
    }
  }
  
  // Method 2: Check submissions page for "Accepted" with test case count
  const passedText = document.body?.innerText || '';
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

function getMonacoModel(): any | undefined {
  try {
    const model = (window as any).monaco?.editor?.getModels?.()[0];
    if (model) {
      log('DEBUG: Found Monaco model in main window');
      return model;
    }
  } catch {}

  try {
    const frames = Array.from(document.querySelectorAll('iframe')) as HTMLIFrameElement[];
    log('DEBUG: Checking', frames.length, 'iframes for Monaco');
    for (const frame of frames) {
      try {
        const win = frame.contentWindow as any;
        const model = win?.monaco?.editor?.getModels?.()[0];
        if (model) {
          log('DEBUG: Found Monaco model in iframe');
          return model;
        }
      } catch {
        // ignore cross-origin frames
      }
    }
  } catch {}

  log('DEBUG: No Monaco model found');
  return undefined;
}

function extractPageLanguage(): string | undefined {
  // Try to access NeetCode's internal state (Angular app data)
  try {
    const win = window as any;
    // Check common paths where Angular apps store state
    if (win.__neetcode_state__?.language) {
      return win.__neetcode_state__.language.toLowerCase();
    }
    if (win.neetcode?.currentLanguage) {
      return win.neetcode.currentLanguage.toLowerCase();
    }
    // Check localStorage for language preference
    const storedLang = localStorage.getItem('selectedLanguage') || 
                      localStorage.getItem('language') ||
                      localStorage.getItem('neetcode-language');
    if (storedLang) {
      const lang = storedLang.toLowerCase().replace(/['"]/g, '');
      if (lang === 'python' || lang === 'python3') return 'python';
      if (lang === 'java') return 'java';
      if (lang === 'cpp' || lang === 'c++') return 'cpp';
      if (lang === 'javascript' || lang === 'js') return 'javascript';
      if (lang === 'typescript' || lang === 'ts') return 'typescript';
    }
  } catch {}

  // Monaco editor language id (most reliable when available)
  try {
    const model = getMonacoModel();
    const langId = model?.getLanguageId?.() ?? model?.getModeId?.();
    log('DEBUG: Monaco langId:', langId);
    if (typeof langId === 'string' && langId.length > 0) {
      const id = langId.toLowerCase();
      if (id === 'java') return 'java';
      if (id === 'python') return 'python';
      if (id === 'cpp' || id === 'c++') return 'cpp';
      if (id === 'javascript') return 'javascript';
      if (id === 'typescript') return 'typescript';
      if (id === 'csharp' || id === 'c#') return 'csharp';
      if (id === 'go') return 'go';
      if (id === 'ruby') return 'ruby';
      if (id === 'swift') return 'swift';
      if (id === 'kotlin') return 'kotlin';
      if (id === 'rust') return 'rust';
    }
  } catch {}

  // Try common elements showing selected language
  const candidates = [
    // NeetCode-specific selectors (from DOM inspection)
    'button.editor-language-btn', // The language dropdown button - MOST RELIABLE
    '.dropdown-item.selected-item', // Selected dropdown item
    'a.dropdown-item.selected-item', // More specific selected item
    '.toggle-btn.editor-language-btn', // Alternative button selector
    // Generic selectors
    '.language-select',
    '[data-selected-language]',
    '[aria-label*="language"]',
    '.editor-toolbar',
    'button[aria-label*="language"]',
    '[class*="language-picker"]',
    '[class*="lang-select"]',
    'button.is-active', // Active language button
    '.dropdown-trigger button', // Dropdown button
    '.select select', // Select element in Bulma CSS
    '[class*="lang"].is-active', // Active language tab
    '.navbar-btn.is-active', // Active navbar button
  ];
  for (const sel of candidates) {
    const el = document.querySelector(sel);
    if (!el) continue;
    
    const text = el?.textContent?.toLowerCase() ?? '';
    const value = (el as HTMLSelectElement)?.value?.toLowerCase() ?? '';
    const ariaLabel = el?.getAttribute('aria-label')?.toLowerCase() ?? '';
    const name = el?.getAttribute('name')?.toLowerCase() ?? '';
    const combined = `${text} ${value} ${ariaLabel} ${name}`.trim();
    
    if (combined.includes('java') && !combined.includes('javascript')) return 'java';
    if (combined.includes('python')) return 'python';
    if (combined.includes('c++')) return 'cpp';
    if (combined.includes('javascript')) return 'javascript';
    if (combined.includes('typescript')) return 'typescript';
    if (combined.includes('c#') || combined.includes('csharp')) return 'csharp';
    if (combined.includes('kotlin')) return 'kotlin';
    if (combined.includes('swift')) return 'swift';
    if (combined.includes('go') && !combined.includes('golang')) return 'go';
    if (combined.includes('ruby')) return 'ruby';
    if (combined.includes('rust')) return 'rust';
  }

  // Broad fallback: inspect small set of languages in body text
  const bodyText = document.body?.innerText?.toLowerCase() ?? '';
  if (bodyText.includes('code | java') && !bodyText.includes('code | javascript')) return 'java';
  if (bodyText.includes('code | python')) return 'python';
  if (bodyText.includes('code | c++')) return 'cpp';
  if (bodyText.includes('code | javascript')) return 'javascript';
  if (bodyText.includes('code | typescript')) return 'typescript';

  return undefined;
}

function detectLanguageFromCode(code: string): string {
  if (!code) return 'unknown';
  
  // Strip leading line numbers (like "123456789class Solution")
  let cleaned = code.replace(/^\d+/, '').trim();
  const firstLines = cleaned.substring(0, 500).toLowerCase();
  
  // Java detection - look for Java-specific keywords and syntax
  if (firstLines.includes('public class') || firstLines.includes('private class') || 
      firstLines.includes('class solution') || firstLines.includes('import java.') ||
      firstLines.includes('arraylist<') || firstLines.includes('hashmap<') ||
      firstLines.includes('public static void') ||
      // Java array syntax: int[], char[], String[], boolean[], etc.
      /\b(int|char|boolean|byte|short|long|float|double|string)\[\]/.test(firstLines) ||
      // Java primitive types with methods: public int, public boolean, etc.
      /\bpublic\s+(int|boolean|void|char|string)/.test(firstLines) ||
      // imports or package statements
      firstLines.includes('package ') && firstLines.includes(';')) {
    return 'java';
  }
  
  // Python detection - expanded patterns
  if (firstLines.includes('def ') || (firstLines.includes('import ') && firstLines.includes(':')) ||
      firstLines.includes('self.') || firstLines.includes('self,') ||
      firstLines.includes('class solution:') || firstLines.includes('list[') ||
      // Python-specific methods and syntax
      firstLines.includes('.items()') ||  // dict.items()
      firstLines.includes('.append(') ||  // list.append()
      firstLines.includes('.get(') ||     // dict.get()
      firstLines.includes('range(') ||    // range() builtin
      firstLines.includes('len(') ||      // len() builtin
      firstLines.includes('enumerate(') || // enumerate() builtin
      /\bfor\s+\w+\s+(,\s*\w+\s+)?in\s+/.test(firstLines) || // for x in ... or for k, v in ...
      /->.*list\[/.test(firstLines) ||    // -> List[...] return type
      firstLines.includes(': list[') ||   // param: List[...]
      firstLines.includes(': dict[') ||   // param: Dict[...]
      firstLines.includes('none:') ||     // -> None:
      (firstLines.includes('true') && firstLines.includes('false'))) { // Python True/False
    return 'python';
  }
  
  // C++ detection
  if (firstLines.includes('#include') || firstLines.includes('std::') || 
      firstLines.includes('vector<') || firstLines.includes('cout <<')) {
    return 'cpp';
  }
  
  // JavaScript/TypeScript detection
  if (firstLines.includes('function') || firstLines.includes('const ') || 
      firstLines.includes('let ') || firstLines.includes('=>') ||
      firstLines.includes('var ') || firstLines.includes('module.exports')) {
    if (firstLines.includes(': number') || firstLines.includes(': string') || 
        firstLines.includes('interface ')) {
      return 'typescript';
    }
    return 'javascript';
  }
  
  // C# detection
  if (firstLines.includes('using system') || firstLines.includes('namespace ')) {
    return 'csharp';
  }
  
  // Go detection
  if (firstLines.includes('package ') || firstLines.includes('func ')) {
    return 'go';
  }
  
  return 'unknown';
}

function extractPageCode(): string | undefined {
  // Try reading Monaco model directly if available
  try {
    const code = getMonacoModel()?.getValue?.();
    if (typeof code === 'string' && code.trim().length > 10) return code.trim();
  } catch {}

  // Prefer textarea value if present (some editors store code here)
  try {
    const textareas = Array.from(document.querySelectorAll('textarea')) as HTMLTextAreaElement[];
    let best: string | undefined;
    for (const ta of textareas) {
      const value = ta.value?.trim();
      if (value && value.length > 10 && (!best || value.length > best.length)) {
        best = value;
      }
    }
    if (best) return best;
  } catch {}

  // Try common code containers as a last resort
  const selectors = [
    '.monaco-editor',
    '.editor',
    '.code-editor',
    'pre code',
    'pre',
    'code',
  ];

  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) {
      const text = el.textContent?.trim();
      if (text && text.length > 10) return text;
    }
  }

  return undefined;
}

function patchFetch() {
  const original = window.fetch;
  window.fetch = async (...args) => {
    const url = getUrl(args[0]);
    const init = (args[1] as RequestInit | undefined);
    const method = init?.method || 'GET';
    
    // Log body for POST/PUT/PATCH requests
    let bodyStr = '';
    if (init?.body && (init.method === 'POST' || init.method === 'PUT' || init.method === 'PATCH')) {
      try {
        bodyStr = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
        if (bodyStr.length > 200) bodyStr = bodyStr.substring(0, 200) + '...';
      } catch {}
    }
    
    log(`DEBUG: FETCH ${method} ${url}${bodyStr ? ' BODY: ' + bodyStr : ''}`);
    const response = await original(...args);
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
      const isAsync = async ?? true;
      return super.open(method, url as any, isAsync, username);
    }

    send(body?: Document | BodyInit | null) {
      let bodyStr = '';
      if (typeof body === 'string') {
        bodyStr = body.length > 200 ? body.substring(0, 200) + '...' : body;
      }
      log(`DEBUG: XHR send to ${this._url}${bodyStr ? ' BODY: ' + bodyStr : ''}`);
      // Capture request body for pairing with response
      try {
        if (typeof body === 'string') {
          try {
            this._reqData = JSON.parse(body);
            log('DEBUG: XHR request body:', this._reqData);
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

// Apply patches IMMEDIATELY at module level, before NeetCode's app loads
patchFetch();
patchXhr();
log('NeetHub: Network patches applied');

async function tryCaptureFromResponse(response: Response, url?: string, init?: RequestInit) {
  log('NeetHub: Fetch intercepted, URL:', url?.substring(0, 100));
  
  let requestBody: unknown = undefined;
  if (init?.body) {
    try {
      requestBody = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
      log('DEBUG: Parsed request body:', requestBody);
    } catch {}
  }
  
  // Check if this looks like a submission request - either by URL or by request body content
  const isSubmissionUrl = urlLooksLikeSubmission(url);
  const isSubmissionBody = requestBody && typeof requestBody === 'object' && 
    (hasProperty(requestBody, ['data', 'lang']) || 
     hasProperty(requestBody, ['data', 'rawCode']) ||
     hasProperty(requestBody, ['lang']) ||
     hasProperty(requestBody, ['rawCode']));
  
  log('DEBUG: isSubmissionUrl:', isSubmissionUrl, 'isSubmissionBody:', isSubmissionBody);
  
  if (!isSubmissionUrl && !isSubmissionBody) {
    log('NeetHub: Not a submission request (URL or body), skipping');
    return;
  }
  
  try {
    const data = await response.json();
    if (isSubmissionBody) {
      log('NeetHub: Submission detected by request body content');
    }
    log('NeetHub: Calling handleCandidate from fetch');
    debugCapture(url ?? '', requestBody, data);
    handleCandidate(data, url ?? '', requestBody);
  } catch (err) {
    warn('NeetHub: failed to parse response json', err);
  }
}

function tryCaptureFromText(text: string, url?: string, requestData?: unknown) {
  log('NeetHub: XHR intercepted, URL:', url?.substring(0, 100));
  
  // Check if this looks like a submission request - either by URL or by request body content
  const isSubmissionUrl = urlLooksLikeSubmission(url);
  const isSubmissionBody = requestData && typeof requestData === 'object' && 
    (hasProperty(requestData, ['data', 'lang']) || 
     hasProperty(requestData, ['data', 'rawCode']) ||
     hasProperty(requestData, ['lang']) ||
     hasProperty(requestData, ['rawCode']));
  
  if (!isSubmissionUrl && !isSubmissionBody) {
    log('NeetHub: Not a submission request via XHR (URL or body), skipping');
    return;
  }
  
  if (isSubmissionBody) {
    log('NeetHub: Submission detected by request body content (XHR)');
  }
  try {
    const data = JSON.parse(text);
    log('NeetHub: Calling handleCandidate from XHR');
    debugCapture(url ?? '', requestData, data);
    handleCandidate(data, url ?? '', requestData);
  } catch (err) {
    // ignore non-JSON
  }
}

function handleCandidate(data: unknown, source: string, requestData?: unknown) {
  log('NeetHub: handleCandidate called with requestData:', requestData ? 'YES' : 'NO');
  const result = extractSubmission(data, requestData);
  if (!result) {
    log('NeetHub: extractSubmission returned null');
    return;
  }

  const { payload, isAccepted } = result;
  
  log('NeetHub: Extracted payload language:', payload.language);
  
  // Store language for auto-trigger to use
  lastRequestLanguage = payload.language;

  // Auto-capture only pushes ACCEPTED submissions
  if (!isAccepted) {
    log('NeetHub: submission not accepted, skipping auto-push');
    return;
  }

  if (isRecent(payload)) {
    log('NeetHub: duplicate submission skipped');
    return;
  }

  log('NeetHub: accepted submission detected, auto-pushing...');
  void pushSubmissionWithEnrichment(payload, source, true); // true = auto-triggered
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
    
    // NeetCode sends data nested: {data: {problemId, lang, rawCode}}
    const reqData = req.data && typeof req.data === 'object' ? req.data as Record<string, unknown> : req;
    
    code = getString(reqData, ['rawCode', 'code', 'solution', 'answer']);
    lang = getString(reqData, ['lang', 'language', 'langSlug']);
    problemId = getString(reqData, ['problemId', 'slug', 'titleSlug', 'questionSlug']);
    
    log('NeetHub: Extracted from request - lang:', lang, 'problemId:', problemId, 'code length:', code?.length);
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
    if (isAccepted && code) {
      let finalLang = lang;
      
      log('NeetHub: Language before fallback:', finalLang);
      
      // Fallback: detect language from code content if not provided
      if (!finalLang || finalLang === 'unknown') {
        finalLang = detectLanguageFromCode(code);
        log('NeetHub: Language after detection:', finalLang);
      }
      
      const runtime = getMetric(singleResult, ['time', 'wall_time']);
      const memory = getMetric(singleResult, ['memory']);
      const ts = getTimestamp(singleResult, ['finished_at', 'created_at']);

      const slug = (problemId || extractPageSlug() || 'unknown').toLowerCase().replace(/\s+/g, '-');
      
      log('NeetHub: Final language for submission:', finalLang);
      
      return {
        payload: {
          title: extractPageTitle() || problemId || 'Unknown Problem',
          slug,
          language: finalLang,
          code,
          runtime: runtime ?? 'n/a',
          memory: memory ?? 'n/a',
          timestamp: ts ?? Date.now(),
          url: buildProblemUrl(slug),
          problemNumber: extractPageNumber(),
          difficulty: extractDifficulty(),
          description: extractProblemDescription(),
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
      let finalLang = lang ?? extractPageLanguage();
      
      log('NeetHub: [Array path] Language from request:', lang);
      log('NeetHub: [Array path] Language from page:', extractPageLanguage());
      log('NeetHub: [Array path] Language before fallback:', finalLang);
      
      // Final fallback: detect language from code content
      if (!finalLang || finalLang === 'unknown') {
        finalLang = detectLanguageFromCode(finalCode || '');
        log('NeetHub: [Array path] Language after code detection:', finalLang);
      }
      
      log('NeetHub: [Array path] Final language:', finalLang);

      if (finalCode) {
        const slug = (problemId || extractPageSlug() || 'unknown').toLowerCase().replace(/\s+/g, '-');
        return {
          payload: {
            title: extractPageTitle() || problemId || 'Unknown Problem',
            slug,
            language: finalLang,
            code: finalCode,
            runtime: runtime ?? 'n/a',
            memory: memory ?? 'n/a',
            timestamp: ts ?? Date.now(),
            url: buildProblemUrl(slug),
            problemNumber: extractPageNumber(),
            difficulty: extractDifficulty(),
            description: extractProblemDescription(),
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
      const slug = (cSlug ?? cTitle ?? 'unknown').toLowerCase().replace(/\s+/g, '-');
      return {
        payload: {
          title: cTitle ?? cSlug ?? 'Unknown Problem',
          slug,
          language: cLang,
          code: cCode,
          runtime: cRuntime ?? 'n/a',
          memory: cMemory ?? 'n/a',
          timestamp: cTs ?? Date.now(),
          url: buildProblemUrl(slug),
          problemNumber: extractPageNumber(),
          difficulty: extractDifficulty(),
          description: extractProblemDescription(),
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
