/**
 * NeetHub OAuth redirect handler.
 * 
 * This content script runs on github.com pages. When the user authorizes
 * NeetHub on GitHub, GitHub redirects to github.com/?code=... 
 * This script catches that redirect, exchanges the code for an access token,
 * fetches the GitHub username, and sends everything to the background script.
 */

const CLIENT_ID = 'Ov23likqHQmClRLa1Vas';
const CLIENT_SECRET = 'a170f6193cf7a570094d8169aa9290d8c95c21f0';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';

function parseAccessCode(url: string): void {
  if (url.match(/\?error=(.+)/)) {
    // Auth was denied or errored — close tab
    chrome.runtime.sendMessage({
      closeWebPage: true,
      isSuccess: false,
    });
    return;
  }

  const codeMatch = url.match(/\?code=([\w\/\-]+)/);
  if (codeMatch && codeMatch[1]) {
    void requestToken(codeMatch[1]);
  }
}

async function requestToken(code: string): Promise<void> {
  try {
    const data = new FormData();
    data.append('client_id', CLIENT_ID);
    data.append('client_secret', CLIENT_SECRET);
    data.append('code', code);

    const response = await fetch(ACCESS_TOKEN_URL, {
      method: 'POST',
      body: data,
    });

    if (!response.ok) {
      chrome.runtime.sendMessage({ closeWebPage: true, isSuccess: false });
      return;
    }

    const text = await response.text();
    const tokenMatch = text.match(/access_token=([^&]*)/);

    if (!tokenMatch || !tokenMatch[1]) {
      chrome.runtime.sendMessage({ closeWebPage: true, isSuccess: false });
      return;
    }

    await finishAuth(tokenMatch[1]);
  } catch {
    chrome.runtime.sendMessage({ closeWebPage: true, isSuccess: false });
  }
}

async function finishAuth(token: string): Promise<void> {
  try {
    // Validate token by fetching the user profile
    const response = await fetch('https://api.github.com/user', {
      headers: { Authorization: `token ${token}` },
    });

    if (!response.ok) {
      chrome.runtime.sendMessage({ closeWebPage: true, isSuccess: false });
      return;
    }

    const user = await response.json();

    chrome.runtime.sendMessage({
      closeWebPage: true,
      isSuccess: true,
      token,
      username: user.login,
    });
  } catch {
    chrome.runtime.sendMessage({ closeWebPage: true, isSuccess: false });
  }
}

// Only process if we're on github.com and the NeetHub pipe flag is set.
// The pipe flag distinguishes an OAuth redirect from a normal github.com visit.
if (window.location.host === 'github.com') {
  chrome.storage.local.get('pipe_neethub', (data) => {
    if (data && data.pipe_neethub) {
      parseAccessCode(window.location.href);
    }
  });
}
