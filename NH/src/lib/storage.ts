export type RepoConfig = {
  owner: string;
  name: string;
  defaultBranch: string;
};

export type AuthState = {
  accessToken?: string;
  username?: string;
};

export type ProblemStatistics = {
  easy: number;
  medium: number;
  hard: number;
};

export type Settings = {
  repo?: RepoConfig;
  auth?: AuthState;
  uploadEnabled: boolean;
  statistics?: ProblemStatistics;
};

const DEFAULT_SETTINGS: Settings = {
  uploadEnabled: true,
  statistics: { easy: 0, medium: 0, hard: 0 },
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
