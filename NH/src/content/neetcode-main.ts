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
    let url = '';
    try {
      url = typeof args[0] === 'string' ? args[0] : (args[0] as Request)?.url ?? '';
      const init = args[1] as RequestInit | undefined;
      if (init?.body && typeof init.body === 'string') {
        tryCaptureCode(init.body, url);
      }
    } catch { /* never break the page */ }

    const result = originalFetch.apply(this, args as any);

    // Also parse the response for submission endpoints to detect acceptance + metrics
    if (isSubmissionUrl(url)) {
      result.then((response: Response) => {
        try {
          response.clone().json().then((data: unknown) => tryCaptureResult(data)).catch(() => {});
        } catch { /* never break the page */ }
      }).catch(() => {});
    }

    return result;
  };

  // ── Track XHR URL via open() ─────────────────────────────────────
  const origOpen = XMLHttpRequest.prototype.open;
  (XMLHttpRequest.prototype as any).open = function (method: string, url: string | URL, ...rest: any[]) {
    (this as any)._nhUrl = typeof url === 'string' ? url : url.toString();
    return (origOpen as any).call(this, method, url, ...rest);
  };

  // ── Patch XMLHttpRequest.prototype.send ─────────────────────────
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.send = function (body?: any) {
    try {
      const url: string = (this as any)._nhUrl ?? '';
      if (body && typeof body === 'string') {
        tryCaptureCode(body, url);
      }
      if (isSubmissionUrl(url)) {
        this.addEventListener('loadend', () => {
          try {
            if (this.responseText) tryCaptureResult(JSON.parse(this.responseText));
          } catch { /* ignore parse errors */ }
        });
      }
    } catch { /* never break the page */ }

    return origSend.call(this, body);
  };

  // ── Helpers ──────────────────────────────────────────────────────

  function isSubmissionUrl(url: string): boolean {
    const lower = url.toLowerCase();
    return lower.includes('submit') || lower.includes('submission');
  }

  function tryCaptureCode(rawBody: string, url: string) {
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

  function tryCaptureResult(data: unknown) {
    try {
      if (!data || typeof data !== 'object') return;
      const root = data as Record<string, unknown>;
      const inner = root.data as Record<string, unknown> | undefined;
      if (!inner || typeof inner !== 'object' || Array.isArray(inner)) return;

      const status = inner.status as Record<string, unknown> | undefined;
      const desc = (status?.description as string | undefined)?.toLowerCase();
      if (desc !== 'accepted') return;

      const runtime = inner.time ?? inner.wall_time;
      const memory = inner.memory;

      window.postMessage(
        {
          source: 'neethub-main-world',
          type: 'captured-submission-result',
          isAccepted: true,
          runtime: runtime != null ? String(runtime) : undefined,
          memory: memory != null ? String(memory) : undefined,
        },
        '*',
      );
    } catch { /* ignore */ }
  }

})();
