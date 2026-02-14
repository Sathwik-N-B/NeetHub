/**
 * NeetHub — Main-world interceptor (LeetHub approach)
 *
 * This tiny script runs in the PAGE's main JavaScript world (not the
 * extension's isolated content-script world). It monkey-patches the real
 * window.fetch and XMLHttpRequest.prototype.send so we can read the
 * exact code string that NeetCode sends to its backend on submit.
 *
 * Captured data is forwarded to the NeetHub content script (isolated
 * world) via window.postMessage.
 */

(function () {
  // ── Patch window.fetch ──────────────────────────────────────────
  const originalFetch = window.fetch;

  window.fetch = function (...args: any[]) {
    try {
      const init = args[1] as RequestInit | undefined;
      if (init?.body && typeof init.body === 'string') {
        tryCapture(init.body, typeof args[0] === 'string' ? args[0] : '');
      }
    } catch { /* never break the page */ }

    return originalFetch.apply(this, args as any);
  };

  // ── Patch XMLHttpRequest.prototype.send ─────────────────────────
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.send = function (body?: any) {
    try {
      if (body && typeof body === 'string') {
        tryCapture(body, '');
      }
    } catch { /* never break the page */ }

    return origSend.call(this, body);
  };

  // ── Shared extraction logic ─────────────────────────────────────
  function tryCapture(rawBody: string, url: string) {
    try {
      const parsed = JSON.parse(rawBody);
      // NeetCode nests submission inside { data: { rawCode, lang, problemId } }
      const data =
        parsed?.data && typeof parsed.data === 'object' ? parsed.data : parsed;

      const code: string | undefined =
        data?.rawCode ?? data?.code ?? data?.solution ?? data?.answer;
      const lang: string | undefined =
        data?.lang ?? data?.language ?? data?.langSlug;

      if (typeof code === 'string' && code.trim().length > 10) {
        window.postMessage(
          {
            source: 'neethub-main-world',
            type: 'captured-submission-code',
            code,
            lang: lang ?? '',
            url,
          },
          '*',
        );
      }
    } catch {
      // body wasn't JSON or didn't contain code — ignore
    }
  }

  console.log('[NeetHub] Main-world network interceptor installed');
})();
