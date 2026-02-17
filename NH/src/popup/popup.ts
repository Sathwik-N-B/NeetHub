import type { Settings } from '../lib/storage';

// DOM Elements
const authBtn = document.getElementById('auth-btn') as HTMLButtonElement;
const repoLinkSection = document.getElementById('repo-link-section') as HTMLDivElement;
const repoLinkSimple = document.getElementById('repo-link-simple') as HTMLAnchorElement;
const statsSection = document.getElementById('stats-section') as HTMLDivElement;
const totalProblems = document.getElementById('total-problems') as HTMLSpanElement;
const easyCount = document.getElementById('easy-count') as HTMLDivElement;
const mediumCount = document.getElementById('medium-count') as HTMLDivElement;
const hardCount = document.getElementById('hard-count') as HTMLDivElement;

let currentSettings: Settings | null = null;

init();

async function init() {
  currentSettings = await chrome.runtime.sendMessage({ type: 'get-settings' }) as Settings;

  updateUI();

  // Event listeners
  authBtn.addEventListener('click', startAuth);

  // Listen for settings changes
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings?.newValue) return;
    currentSettings = changes.settings.newValue as Settings;
    updateUI();
  });
}

function startAuth() {
  // Start GitHub OAuth directly from popup (LeetHub approach)
  const CLIENT_ID = 'Ov23likqHQmClRLa1Vas';
  const SCOPES = 'repo';
  const url = `https://github.com/login/oauth/authorize?client_id=${CLIENT_ID}&scope=${encodeURIComponent(SCOPES)}`;

  // Set pipe flag so the authorize content script catches the redirect
  chrome.storage.local.set({ pipe_neethub: true }, () => {
    chrome.tabs.create({ url, active: true });
  });
}

function updateUI() {
  const isConfigured = currentSettings?.auth?.accessToken && 
                       currentSettings?.repo?.owner && 
                       currentSettings?.repo?.name;

  if (isConfigured) {
    // Show configured state — hide auth section completely
    document.getElementById('auth-section')!.style.display = 'none';
    
    // Show simple repo link
    repoLinkSection.style.display = 'block';
    if (currentSettings?.repo) {
      const repoFullName = `${currentSettings.repo.owner}/${currentSettings.repo.name}`;
      repoLinkSimple.textContent = repoFullName;
      repoLinkSimple.href = `https://github.com/${repoFullName}`;
    }

    // Show statistics
    statsSection.classList.add('show');
    updateStatistics();
  } else {
    // Show setup state
    document.getElementById('auth-section')!.style.display = 'block';
    repoLinkSection.style.display = 'none';
    statsSection.classList.remove('show');
    authBtn.innerHTML = `
      <svg class="github-icon" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
      </svg>
      Authenticate
    `;
  }
}

function updateStatistics() {
  // Get statistics from settings
  const stats = currentSettings?.statistics || { easy: 0, medium: 0, hard: 0 };
  const total = stats.easy + stats.medium + stats.hard;
  
  totalProblems.textContent = total.toString();
  easyCount.textContent = stats.easy.toString();
  mediumCount.textContent = stats.medium.toString();
  hardCount.textContent = stats.hard.toString();
}

function openSetupPage() {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/welcome/welcome.html') });
}
