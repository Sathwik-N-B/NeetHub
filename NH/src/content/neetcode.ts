import { log, warn } from '../lib/logger';
import type { SubmissionPayload } from '../lib/github';

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

// Auto-capture: hook fetch/XHR to detect submission responses
patchFetch();
patchXhr();

let recentKeys = new Set<string>();
const RECENT_TTL_MS = 10 * 60 * 1000; // dedupe window

function patchFetch() {
  const original = window.fetch;
  window.fetch = async (...args) => {
    const response = await original(...args);
    tryCaptureFromResponse(response.clone(), getUrl(args[0]));
    return response;
  };
}

function patchXhr() {
  const OriginalXHR = window.XMLHttpRequest;
  class WrappedXHR extends OriginalXHR {
    private _url = '';

    open(method: string, url: string | URL, ...rest: unknown[]) {
      this._url = typeof url === 'string' ? url : url.toString();
      return super.open(method, url, ...(rest as Parameters<XMLHttpRequest['open']>));
    }

    send(body?: Document | BodyInit | null) {
      this.addEventListener('loadend', () => {
        if (!this.responseType || this.responseType === 'text') {
          tryCaptureFromText(this.responseText, this._url);
        }
      });
      return super.send(body as Parameters<XMLHttpRequest['send']>[0]);
    }
  }

  window.XMLHttpRequest = WrappedXHR as typeof XMLHttpRequest;
}

async function tryCaptureFromResponse(response: Response, url?: string) {
  if (!isLikelySubmissionUrl(url)) return;
  try {
    const data = await response.json();
    handleCandidate(data, url ?? '');
  } catch (err) {
    warn('NeetHub: failed to parse response json', err);
  }
}

function tryCaptureFromText(text: string, url?: string) {
  if (!isLikelySubmissionUrl(url)) return;
  try {
    const data = JSON.parse(text);
    handleCandidate(data, url ?? '');
  } catch (err) {
    // ignore non-JSON
  }
}

function handleCandidate(data: unknown, source: string) {
  const payload = extractSubmission(data);
  if (!payload) return;

  if (isRecent(payload)) {
    log('NeetHub: duplicate submission skipped');
    return;
  }

  void pushSubmission(payload, source);
}

async function pushSubmission(payload: SubmissionPayload, source: string) {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'submission', payload });
    if (response?.ok) {
      markRecent(payload);
      log('Submission sent to background from', source);
    } else {
      warn('Submission failed', response?.error);
    }
  } catch (err) {
    warn('Failed to send submission', err);
  }
}

function extractSubmission(data: unknown): SubmissionPayload | undefined {
  if (!data || typeof data !== 'object') return undefined;

  const queue: unknown[] = [data];
  let steps = 0;

  while (queue.length && steps < 200) {
    steps += 1;
    const current = queue.shift();
    if (!current || typeof current !== 'object') continue;
    const candidate = current as Record<string, unknown>;

    const code = getString(candidate, ['code', 'solution', 'answer']);
    const lang = getString(candidate, ['lang', 'language', 'langSlug']);
    const title = getString(candidate, ['title', 'questionTitle', 'problemTitle']);
    const slug = getString(candidate, ['slug', 'titleSlug', 'questionSlug', 'problemSlug']);
    const runtime = getMetric(candidate, ['runtime', 'runTime', 'time']);
    const memory = getMetric(candidate, ['memory', 'mem']);
    const ts = getTimestamp(candidate, ['timestamp', 'createdAt', 'submittedAt']);

    if (code && (title || slug) && lang) {
      return {
        title: title ?? slug ?? 'Unknown Problem',
        slug: (slug ?? title ?? 'unknown').toLowerCase().replace(/\s+/g, '-'),
        language: lang,
        code,
        runtime: runtime ?? 'n/a',
        memory: memory ?? 'n/a',
        timestamp: ts ?? Date.now(),
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

function isLikelySubmissionUrl(url?: string): boolean {
  if (!url) return false;
  return /submission|submit|judge/i.test(url) && url.includes('neetcode');
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
