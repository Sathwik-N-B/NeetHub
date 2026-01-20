import type { RepoConfig, Settings } from '../lib/storage';

const ownerInput = document.querySelector<HTMLInputElement>('#repo-owner');
const nameInput = document.querySelector<HTMLInputElement>('#repo-name');
const branchInput = document.querySelector<HTMLInputElement>('#repo-branch');
const statusEl = document.querySelector<HTMLDivElement>('#status');
const saveRepoBtn = document.querySelector<HTMLButtonElement>('#save-repo');
const authBtn = document.querySelector<HTMLButtonElement>('#auth');
const logoutBtn = document.querySelector<HTMLButtonElement>('#logout');

init();

async function init() {
  const settings = (await chrome.runtime.sendMessage({ type: 'get-settings' })) as Settings;
  ownerInput!.value = settings.repo?.owner ?? '';
  nameInput!.value = settings.repo?.name ?? '';
  branchInput!.value = settings.repo?.defaultBranch ?? 'main';

  saveRepoBtn?.addEventListener('click', saveRepo);
  authBtn?.addEventListener('click', startAuth);
  logoutBtn?.addEventListener('click', logout);
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

async function startAuth() {
  const flow = await chrome.runtime.sendMessage({ type: 'start-auth' });
  if (flow?.verificationUri && flow?.userCode) {
    setStatus(`Visit ${flow.verificationUri} and enter ${flow.userCode}`);
  } else {
    setStatus('Failed to start authorization');
  }
}

async function logout() {
  const response = await chrome.runtime.sendMessage({ type: 'logout' });
  setStatus(response?.ok ? 'Logged out' : 'Logout failed');
}

function setStatus(message: string) {
  statusEl!.innerText = message;
}
