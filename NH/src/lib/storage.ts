export type RepoConfig = {
  owner: string;
  name: string;
  defaultBranch: string;
};

export type AuthState = {
  deviceCode?: string;
  accessToken?: string;
  expiresAt?: number;
};

export type Settings = {
  repo?: RepoConfig;
  auth?: AuthState;
  uploadEnabled: boolean;
};

const DEFAULT_SETTINGS: Settings = {
  uploadEnabled: true,
};

export async function getSettings(): Promise<Settings> {
  const result = await chrome.storage.local.get(['settings']);
  return { ...DEFAULT_SETTINGS, ...(result.settings as Settings | undefined) };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ settings });
}

export async function clearAuth(): Promise<void> {
  const settings = await getSettings();
  await saveSettings({ ...settings, auth: undefined });
}
