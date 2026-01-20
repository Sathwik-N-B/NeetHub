import { log, warn } from '../lib/logger';
import type { SubmissionPayload } from '../lib/github';

// Listen for page-context events sent via window.postMessage({ source: 'neetcode', type: 'submission', payload })
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== 'neetcode' || data.type !== 'submission') return;

  const payload = data.payload as SubmissionPayload;
  if (!payload?.code) {
    warn('NeetHub: submission payload missing code');
    return;
  }

  void pushSubmission(payload);
});

// TODO: Implement automatic scraping of NeetCode submissions by observing fetch/XHR responses.

async function pushSubmission(payload: SubmissionPayload) {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'submission', payload });
    if (response?.ok) {
      log('Submission sent to background');
    } else {
      warn('Submission failed', response?.error);
    }
  } catch (err) {
    warn('Failed to send submission', err);
  }
}
