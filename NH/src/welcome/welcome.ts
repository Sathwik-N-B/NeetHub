import type { RepoConfig, Settings } from '../lib/storage';

// DOM Elements
const authBtn = document.getElementById('auth-btn') as HTMLButtonElement;
const authStatus = document.getElementById('auth-status') as HTMLDivElement;
const repoSection = document.getElementById('repo-section') as HTMLDivElement;
const repoAction = document.getElementById('repo-action') as HTMLSelectElement;
const repoList = document.getElementById('repo-list') as HTMLSelectElement;
const existingRepoSection = document.getElementById('existing-repo-section') as HTMLDivElement;
const createNewSection = document.getElementById('create-new-section') as HTMLDivElement;
const newRepoName = document.getElementById('new-repo-name') as HTMLInputElement;
const getStartedBtn = document.getElementById('get-started-btn') as HTMLButtonElement;
const repoStatus = document.getElementById('repo-status') as HTMLDivElement;

let currentSettings: Settings | null = null;
let userRepos: any[] = [];

// Initialize
init();

async function init() {
  // Check if already authenticated and configured
  const settings = await chrome.runtime.sendMessage({ type: 'get-settings' }) as Settings;
  currentSettings = settings;

  if (settings.auth?.accessToken) {
    if (settings.repo?.owner && settings.repo?.name) {
      // Already fully configured — show LeetHub-style linked message
      document.getElementById('auth-section')!.style.display = 'none';
      repoSection.innerHTML = '';
      showLinkedState(settings.repo.owner, settings.repo.name);
      return;
    }
    
    // Authenticated but no repo — hide auth UI, show repo section directly
    document.getElementById('auth-section')!.style.display = 'none';
    showSuccess(authStatus, `✓ Authenticated as ${settings.auth.username || 'GitHub user'}`);
    enableRepoSection();
    await loadUserRepos();
  }

  // Event listeners
  authBtn.addEventListener('click', handleAuth);
  repoAction.addEventListener('change', handleRepoActionChange);
  repoList.addEventListener('change', handleRepoSelection);
  getStartedBtn.addEventListener('click', handleGetStarted);

  // Listen for auth completion
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings?.newValue) return;
    const newSettings = changes.settings.newValue as Settings;
    currentSettings = newSettings;
    
    if (newSettings.auth?.accessToken && !settings.auth?.accessToken) {
      // Just authenticated — reset button and show success
      authBtn.disabled = false;
      authBtn.innerHTML = '✓ Authenticated';
      authBtn.style.pointerEvents = 'none';
      showSuccess(authStatus, '✓ Successfully authenticated with GitHub!');
      enableRepoSection();
      void loadUserRepos();
    }
  });
}

async function handleAuth() {
  authBtn.disabled = true;
  authBtn.innerHTML = '<span class="loading"></span> Authenticating...';

  const CLIENT_ID = 'Ov23likqHQmClRLa1Vas';
  const SCOPES = 'repo';

  // Don't include redirect_uri — GitHub will use the callback URL configured in the app settings
  const url = `https://github.com/login/oauth/authorize?client_id=${CLIENT_ID}&scope=${encodeURIComponent(SCOPES)}`;

  // Set pipe flag so the authorize content script knows to catch the redirect
  chrome.storage.local.set({ pipe_neethub: true }, () => {
    chrome.tabs.create({ url, active: true });
  });

  authBtn.innerHTML = '<span class="loading"></span> Waiting for authorization...';
}

function enableRepoSection() {
  repoSection.classList.add('enabled');
  repoAction.disabled = false;
}

async function loadUserRepos() {
  if (!currentSettings?.auth?.accessToken) return;
  
  try {
    const response = await fetch('https://api.github.com/user/repos?per_page=100&sort=updated', {
      headers: {
        'Authorization': `token ${currentSettings.auth.accessToken}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });
    
    if (!response.ok) throw new Error('Failed to fetch repositories');
    
    userRepos = await response.json();
    
    // Populate dropdown
    repoList.innerHTML = '<option value="">Select a Repository</option>';
    userRepos.forEach(repo => {
      const option = document.createElement('option');
      option.value = repo.full_name;
      option.textContent = repo.full_name;
      repoList.appendChild(option);
    });
    
  } catch (error) {
    console.error('Failed to load repos:', error);
    showError(repoStatus, 'Failed to load your repositories');
  }
}

function handleRepoActionChange() {
  const action = repoAction.value;
  
  existingRepoSection.classList.toggle('hidden', action !== 'existing');
  createNewSection.classList.toggle('show', action === 'create');
  
  if (action === 'existing') {
    repoList.disabled = false;
    getStartedBtn.disabled = true;
  } else if (action === 'create') {
    getStartedBtn.disabled = false;
  } else {
    getStartedBtn.disabled = true;
  }
}

function handleRepoSelection() {
  getStartedBtn.disabled = !repoList.value;
}

async function handleGetStarted() {
  const action = repoAction.value;
  
  if (action === 'existing') {
    await linkExistingRepo();
  } else if (action === 'create') {
    await createNewRepo();
  }
}

async function linkExistingRepo() {
  const selected = repoList.value;
  if (!selected) return;
  
  const [owner, name] = selected.split('/');
  
  getStartedBtn.disabled = true;
  getStartedBtn.innerHTML = '<span class="loading"></span> Linking...';
  
  const repo: RepoConfig = {
    owner,
    name,
    defaultBranch: 'main'
  };
  
  const response = await chrome.runtime.sendMessage({ type: 'save-repo', payload: repo });
  
  if (response?.ok) {
    repoSection.innerHTML = '';
    showLinkedState(owner, name);
  } else {
    showError(repoStatus, response?.error || 'Failed to link repository');
    getStartedBtn.disabled = false;
    getStartedBtn.textContent = 'Get Started';
  }
}

async function createNewRepo() {
  const name = newRepoName.value.trim();
  
  if (!name) {
    showError(repoStatus, 'Please enter a repository name');
    return;
  }
  
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    showError(repoStatus, 'Invalid repository name. Use only letters, numbers, dots, hyphens, and underscores.');
    return;
  }
  
  getStartedBtn.disabled = true;
  getStartedBtn.innerHTML = '<span class="loading"></span> Creating...';
  
  try {
    // Create repository
    const createResponse = await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers: {
        'Authorization': `token ${currentSettings!.auth!.accessToken}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name,
        private: true,
        description: 'NeetHub - Automated NeetCode submissions',
        auto_init: true
      })
    });
    
    if (!createResponse.ok) {
      const error = await createResponse.json();
      throw new Error(error.message || 'Failed to create repository');
    }
    
    const repoData = await createResponse.json();
    
    // Save repo config
    const repo: RepoConfig = {
      owner: repoData.owner.login,
      name: repoData.name,
      defaultBranch: repoData.default_branch || 'main'
    };
    
    const saveResponse = await chrome.runtime.sendMessage({ type: 'save-repo', payload: repo });
    
    if (saveResponse?.ok) {
      repoSection.innerHTML = '';
      showLinkedState(repo.owner, repo.name);
    } else{
      throw new Error(saveResponse?.error || 'Failed to save repository');
    }
    
  } catch (error: any) {
    showError(repoStatus, error.message || 'Failed to create repository');
    getStartedBtn.disabled = false;
    getStartedBtn.textContent = 'Get Started';
  }
}

function showSuccess(el: HTMLElement, message: string) {
  el.className = 'status-message success show';
  el.textContent = message;
}

function showError(el: HTMLElement, message: string) {
  el.className = 'status-message error show';
  el.textContent = message;
}

function showInfo(el: HTMLElement, message: string) {
  el.className = 'status-message info show';
  el.textContent = message;
}

function showLinkedState(owner: string, name: string) {
  const container = document.querySelector('.container') as HTMLElement;
  
  // Find or create the linked-message area
  let linkedDiv = document.getElementById('linked-state');
  if (!linkedDiv) {
    linkedDiv = document.createElement('div');
    linkedDiv.id = 'linked-state';
    linkedDiv.style.cssText = 'text-align: center; margin-top: 20px;';
    // Insert after separator
    const separator = container.querySelector('.separator');
    if (separator) {
      separator.after(linkedDiv);
    } else {
      container.appendChild(linkedDiv);
    }
  }

  linkedDiv.innerHTML = `
    <p style="font-size: 16px; color: #7ee787; margin-bottom: 8px;">
      Successfully linked <a href="https://github.com/${owner}/${name}" target="_blank" style="color: #fff; font-weight: 700; text-decoration: none;">${owner}/${name}</a> to NeetHub. Start <a href="https://neetcode.io" target="_blank" style="color: #fff; font-weight: 700; text-decoration: none;">NeetCoding</a> <span style="color: #7ee787;">now!</span>
    </p>
    <p style="font-size: 13px; color: #b3b3b3;">
      Linked the wrong repo? <a href="#" id="unlink-btn" style="color: #fff; font-weight: 600; text-decoration: none;">Unlink</a>
    </p>
  `;

  document.getElementById('unlink-btn')?.addEventListener('click', async (e) => {
    e.preventDefault();
    // Clear repo from settings via chrome.storage directly
    const result = await chrome.storage.local.get('settings');
    const settings = result.settings || {};
    delete settings.repo;
    await chrome.storage.local.set({ settings });
    // Reload to show setup form again
    window.location.reload();
  });
}
