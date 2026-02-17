import { commitSubmission, ensureRepo, type SubmissionPayload } from '../lib/github';
import { clearAuth, getSettings, saveSettings, type RepoConfig } from '../lib/storage';
import { error, log, warn } from '../lib/logger';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void handleMessage(message, sender).then(sendResponse).catch((err) => {
    error('Unhandled error', err);
    sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
  });
  return true;
});

async function handleMessage(message: unknown, sender?: chrome.runtime.MessageSender): Promise<unknown> {
  if (!message || typeof message !== 'object') return { ok: false, error: 'bad-message' };

  const msg = message as Record<string, unknown>;

  // Handle OAuth redirect completion from authorize content script
  if (msg.closeWebPage !== undefined) {
    return handleOAuthComplete(msg, sender);
  }

  const { type, payload } = msg as { type: string; payload?: unknown };

  switch (type) {
    case 'submission':
      return handleSubmission(payload as SubmissionPayload);
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

async function handleOAuthComplete(
  msg: Record<string, unknown>,
  sender?: chrome.runtime.MessageSender
): Promise<unknown> {
  if (msg.isSuccess) {
    const token = msg.token as string;
    const username = msg.username as string;

    // Save auth to settings
    const settings = await getSettings();
    await saveSettings({
      ...settings,
      auth: { accessToken: token, username },
    });
    log(`GitHub OAuth complete for ${username}`);

    // Clear pipe flag
    await chrome.storage.local.set({ pipe_neethub: false });

    // Close the GitHub redirect tab (sender is the authorize content script tab)
    if (sender?.tab?.id) {
      try {
        await chrome.tabs.remove(sender.tab.id);
      } catch {
        // Tab might already be closed
      }
    }

    // Open the welcome/setup page for repo configuration
    const welcomeUrl = chrome.runtime.getURL('src/welcome/welcome.html');
    await chrome.tabs.create({ url: welcomeUrl, active: true });

    return { ok: true };
  } else {
    // Auth failed — close the tab
    if (sender?.tab?.id) {
      try {
        await chrome.tabs.remove(sender.tab.id);
      } catch {
        // ignore
      }
    }
    return { ok: false, error: 'auth-failed' };
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
    void setBadge('success');
    return { ok: true };
  } catch (err) {
    warn('Submission failed', err);
    void setBadge('error');
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function setBadge(state: 'success' | 'error') {
  const text = state === 'success' ? '✓' : '!';
  const color = state === 'success' ? '#16a34a' : '#dc2626';

  try {
    await chrome.action?.setBadgeBackgroundColor({ color });
    await chrome.action?.setBadgeText({ text });
    setTimeout(() => {
      void chrome.action?.setBadgeText({ text: '' });
    }, 3000);
  } catch {
    // ignore badge failures
  }
}
