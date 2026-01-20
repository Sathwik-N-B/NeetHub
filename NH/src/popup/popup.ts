import type { RepoConfig, Settings } from '../lib/storage';

const ownerInput = document.querySelector<HTMLInputElement>('#repo-owner');
const nameInput = document.querySelector<HTMLInputElement>('#repo-name');
const branchInput = document.querySelector<HTMLInputElement>('#repo-branch');
const uploadCheckbox = document.querySelector<HTMLInputElement>('#upload-enabled');
const statusEl = document.querySelector<HTMLDivElement>('#status');
const saveRepoBtn = document.querySelector<HTMLButtonElement>('#save-repo');
const authBtn = document.querySelector<HTMLButtonElement>('#auth');
const logoutBtn = document.querySelector<HTMLButtonElement>('#logout');

init();

async function init() {
  const settings = (await chrome.runtime.sendMessage({ type: 'get-settings' })) as Settings;
  populate(settings);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings?.newValue) return;
    populate(changes.settings.newValue as Settings);
  });

  saveRepoBtn?.addEventListener('click', saveRepo);
  uploadCheckbox?.addEventListener('change', toggleUpload);
  authBtn?.addEventListener('click', startAuth);
  logoutBtn?.addEventListener('click', logout);
}

function populate(settings: Settings) {
  ownerInput!.value = settings.repo?.owner ?? '';
  nameInput!.value = settings.repo?.name ?? '';
  branchInput!.value = settings.repo?.defaultBranch ?? 'main';
  uploadCheckbox!.checked = settings.uploadEnabled;
  statusEl!.innerText = settings.auth?.accessToken ? 'Connected to GitHub' : 'Not authorized';
}

async function saveRepo() {
  const repo: RepoConfig = {
    owner: ownerInput!.value.trim(),
    name: nameInput!.value.trim(),
    defaultBranch: branchInput!.value.trim() || 'main',
  };

  const response = await chrome.runtime.sendMessage({ type: 'save-repo', payload: repo });
  setStatus(response?.ok ? 'Repository saved' : `Failed: ${response?.error ?? 'unknown'}`);
}

async function toggleUpload() {
  const enabled = uploadCheckbox!.checked;
  const response = await chrome.runtime.sendMessage({ type: 'toggle-upload', payload: enabled });
  setStatus(response?.ok ? 'Auto-upload updated' : 'Failed to update');
}

async function startAuth() {
  const response = await chrome.runtime.sendMessage({ type: 'start-auth' });
  if (response?.ok && response.flow?.verificationUri && response.flow?.userCode) {
    setStatus(`Visit ${response.flow.verificationUri} and enter ${response.flow.userCode}`);
  } else if (response?.error) {
    setStatus(`Auth failed: ${response.error}`);
  } else {
    setStatus('Failed to start auth');
  }
}

async function logout() {
  const response = await chrome.runtime.sendMessage({ type: 'logout' });
  setStatus(response?.ok ? 'Logged out' : 'Logout failed');
}

function setStatus(message: string) {
  statusEl!.innerText = message;
}
