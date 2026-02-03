import { error, log } from './logger';
import type { RepoConfig } from './storage';

const CLIENT_ID = 'Ov23likqHQmClRLa1Vas';

export type DeviceFlowStart = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
};

export async function startDeviceFlow(scope = 'repo'): Promise<DeviceFlowStart> {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    scope,
  });

  const response = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub device flow start failed: ${response.status} ${text || ''}`.trim());
  }

  const payload = await response.json();
  if (payload.error) {
    throw new Error(payload.error_description ?? payload.error);
  }
  return {
    deviceCode: payload.device_code,
    userCode: payload.user_code,
    verificationUri: payload.verification_uri,
    expiresIn: payload.expires_in,
    interval: payload.interval ?? 5,
  };
}

export async function pollForToken(deviceCode: string, intervalSeconds: number): Promise<string> {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    device_code: deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  });

  while (true) {
    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: params.toString(),
    });

    if (!response.ok) {
      throw new Error(`GitHub token polling failed: ${response.status}`);
    }

    const payload = await response.json();

    if (payload.error === 'authorization_pending') {
      await wait(intervalSeconds * 1000);
      continue;
    }

    if (payload.error) {
      throw new Error(`GitHub token polling error: ${payload.error}`);
    }

    if (!payload.access_token) {
      throw new Error('GitHub token not present in response');
    }

    return payload.access_token as string;
  }
}

export async function ensureRepo(token: string, repo: RepoConfig): Promise<void> {
  const existing = await fetchGitHub<{ default_branch: string }>(`/repos/${repo.owner}/${repo.name}`, token);

  if (!existing.ok && existing.status === 404) {
    log('Repository missing, creating...');
    const createResponse = await fetchGitHub(
      `/user/repos`,
      token,
      'POST',
      {
        name: repo.name,
        private: true,
        description: 'NeetHub automated submissions',
      },
    );

    if (!createResponse.ok) {
      throw new Error(`Failed to create repository: ${createResponse.status}`);
    }
    return;
  }

  if (!existing.ok) {
    throw new Error(`Failed to read repository: ${existing.status}`);
  }
}

export type SubmissionPayload = {
  title: string;
  slug: string;
  language: string;
  code: string;
  runtime: string;
  memory: string;
  timestamp: number;
      url?: string;
};

export async function commitSubmission(token: string, repo: RepoConfig, submission: SubmissionPayload): Promise<void> {
  const codePath = buildCodePath(submission);
  const readmePath = buildReadmePath(submission);

  const statsMessage = buildStatsMessage(submission);

  await commitFile(
    token,
    repo,
    readmePath,
    toBase64(formatReadme(submission)),
    `Update README: ${submission.title}`,
  );

  await commitFile(
    token,
    repo,
    codePath,
    toBase64(formatCodeFile(submission)),
    statsMessage,
  );
}

async function getExistingFileSha(token: string, repo: RepoConfig, path: string): Promise<string | undefined> {
  const response = await fetchGitHub<{ sha?: string }>(
    `/repos/${repo.owner}/${repo.name}/contents/${path}`,
    token,
  );

  if (response.ok) {
    const sha = response.data?.sha;
    return typeof sha === 'string' && sha.length > 0 ? sha : undefined;
  }

  if (response.status === 404) return undefined;

  const text = await response.text();
  throw new Error(`Failed to check existing file: ${response.status} ${text || ''}`.trim());
}

const BASE_PATH = 'NeetCode';

function formatCodeFile(submission: SubmissionPayload): string {
  return `// NeetCode: ${submission.title}\n// Runtime: ${submission.runtime}, Memory: ${submission.memory}\n// Submitted: ${new Date(submission.timestamp).toISOString()}\n\n${submission.code}\n`;
}

function formatReadme(submission: SubmissionPayload): string {
  const submitted = new Date(submission.timestamp).toISOString();
  const urlLine = submission.url ? `- URL: ${submission.url}\n` : '';
  return `# ${submission.title}\n\n${urlLine}- Language: ${submission.language}\n- Runtime: ${submission.runtime}\n- Memory: ${submission.memory}\n- Submitted: ${submitted}\n`;
}

function buildFolder(submission: SubmissionPayload): string {
  return `${BASE_PATH}/${submission.slug}`;
}

function buildCodePath(submission: SubmissionPayload): string {
  const filename = `${submission.slug}.${extensionFor(submission.language)}`;
  return `${buildFolder(submission)}/${filename}`;
}

function buildReadmePath(submission: SubmissionPayload): string {
  return `${buildFolder(submission)}/README.md`;
}

function buildStatsMessage(submission: SubmissionPayload): string {
  const runtime = submission.runtime || 'n/a';
  const memory = submission.memory || 'n/a';
  return `Time: ${runtime}, Memory: ${memory} - NeetHub`;
}

function extensionFor(language: string): string {
  const normalized = language.toLowerCase();
  if (normalized.includes('python')) return 'py';
  if (normalized.includes('java')) return 'java';
  if (normalized.includes('cpp')) return 'cpp';
  if (normalized.includes('javascript') || normalized.includes('node')) return 'js';
  if (normalized.includes('typescript')) return 'ts';
  if (normalized.includes('c#')) return 'cs';
  return 'txt';
}

function toBase64(text: string): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  let binary = '';

  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });

  return btoa(binary);
}

async function commitFile(
  token: string,
  repo: RepoConfig,
  path: string,
  content: string,
  message: string,
): Promise<void> {
  const existingSha = await getExistingFileSha(token, repo, path);
  const body: Record<string, unknown> = {
    message,
    content,
  };
  if (existingSha) {
    body.sha = existingSha;
  }

  const response = await fetchGitHub(
    `/repos/${repo.owner}/${repo.name}/contents/${path}`,
    token,
    'PUT',
    body,
  );

  if (!response.ok) {
    const text = await response.text();
    error('Failed to commit file', text);
    throw new Error(`Commit failed: ${response.status}`);
  }
}

async function fetchGitHub<T = unknown>(path: string, token: string, method = 'GET', body?: unknown) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const ok = response.ok;
  const status = response.status;
  const data = ok ? ((await response.json()) as T) : undefined;
  return { ok, status, data, text: () => response.text() };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
