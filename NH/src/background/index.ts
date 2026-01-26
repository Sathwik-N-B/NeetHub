import { commitSubmission, ensureRepo, pollForToken, startDeviceFlow, type SubmissionPayload } from '../lib/github';
import { clearAuth, getSettings, saveSettings, type RepoConfig } from '../lib/storage';
import { error, log, warn } from '../lib/logger';

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void handleMessage(message).then(sendResponse).catch((err) => {
    error('Unhandled error', err);
    sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
  });
  return true;
});

async function handleMessage(message: unknown): Promise<unknown> {
  if (!message || typeof message !== 'object') return { ok: false, error: 'bad-message' };

  const { type, payload } = message as { type: string; payload?: unknown };

  switch (type) {
    case 'submission':
      return handleSubmission(payload as SubmissionPayload);
    case 'start-auth':
      return handleAuth();
    case 'resume-auth':
      return resumeAuth();
    case 'get-settings':
      return getSettings();
    case 'save-repo':
      return handleSaveRepo(payload as RepoConfig);
    case 'toggle-upload':
      return handleToggle(payload as boolean);
    case 'logout':
      await clearAuth();
      return { ok: true };
    default:
      return { ok: false, error: 'unknown-message' };
  }
}

// Retry token polling if the user already completed device flow in the browser
async function resumeAuth() {
  const settings = await getSettings();
  const deviceCode = settings.auth?.deviceCode;
  if (!deviceCode || settings.auth?.accessToken) return { ok: false, error: 'no-pending-auth' };
  try {
    const token = await pollForToken(deviceCode, 5);
    const latest = await getSettings();
    await saveSettings({ ...latest, auth: { accessToken: token, expiresAt: Date.now() + 3600_000 } });
    log('GitHub token saved (resume)');
    return { ok: true };
  } catch (err) {
    error('Auth resume failed', err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function handleAuth() {
  try {
    const flow = await startDeviceFlow();
    log('Device flow started');

    const settings = await getSettings();
    await saveSettings({ ...settings, auth: { deviceCode: flow.deviceCode } });

    // Don't create notification here - popup will handle user interaction

    // Poll in background; errors logged.
    void pollForToken(flow.deviceCode, flow.interval)
      .then(async (token) => {
        const latest = await getSettings();
        const expiresAt = Date.now() + flow.expiresIn * 1000;
        await saveSettings({ ...latest, auth: { accessToken: token, expiresAt } });
        log('GitHub token saved');
      })
      .catch((err) => error('Auth polling failed', err));

    return { ok: true, flow };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    error('Auth start failed', message);
    return { ok: false, error: message };
  }
}

async function handleSaveRepo(repo: RepoConfig) {
  const settings = await getSettings();
  await saveSettings({ ...settings, repo });
  return { ok: true };
}

async function handleToggle(enabled: boolean) {
  const settings = await getSettings();
  await saveSettings({ ...settings, uploadEnabled: enabled });
  return { ok: true };
}

async function handleSubmission(submission: SubmissionPayload) {
  const settings = await getSettings();
  if (!settings.uploadEnabled) return { ok: false, error: 'disabled' };

  if (!settings.auth?.accessToken) return { ok: false, error: 'missing-auth' };
  if (!settings.repo) return { ok: false, error: 'missing-repo' };

  try {
    await ensureRepo(settings.auth.accessToken, settings.repo);
    await commitSubmission(settings.auth.accessToken, settings.repo, submission);
    log('Submission pushed');
    // Notify user on success
    void chrome.notifications.create({
      type: 'basic',
      title: 'NeetHub',
      message: `✓ Committed: ${submission.title}`,
    });
    return { ok: true };
  } catch (err) {
    warn('Submission failed', err);
    // Notify user on failure
    void chrome.notifications.create({
      type: 'basic',
      title: 'NeetHub',
      message: `✗ Commit failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
