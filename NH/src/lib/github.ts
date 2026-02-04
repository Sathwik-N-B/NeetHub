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
  problemNumber?: string;
  difficulty?: string;
  description?: string;
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
    `Create README - NeetHub`,
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
  const questionUrl = submission.url || '';
  const title = submission.title || 'Problem';
  const difficulty = submission.difficulty || 'Unknown';
  let description = submission.description || '';

  // Clean description of hints and metadata
  description = cleanDescription(description);

  // Match LeetCode format: title, difficulty, and description
  return `<h2><a href="${questionUrl}">${title}</a></h2><h3>${difficulty}</h3><hr>${description}`;
}

function cleanDescription(html: string): string {
  if (!html) return '';
  
  let cleaned = html;
  
  // Remove details elements with hint or company tags accordion classes
  cleaned = cleaned.replace(/<details[^>]*class="[^"]*(?:hint|company-tags)-accordion[^"]*"[^>]*>[\s\S]*?<\/details>/gi, '');
  
  // Remove br tags that are used as separators (multiple consecutive brs)
  cleaned = cleaned.replace(/<br\s*\/?>\s*<br\s*\/?>/gi, '');
  
  // Remove standalone Company Tags, Hints, Topics text sections at the end
  cleaned = cleaned.replace(/(?:<div[^>]*>)*\s*(?:Company\s+)?Tags[\s\S]*$/gi, '');
  cleaned = cleaned.replace(/(?:<div[^>]*>)*\s*Recommended[\s\S]*$/gi, '');
  cleaned = cleaned.replace(/(?:<div[^>]*>)*\s*Hint\s+\d+[\s\S]*$/gi, '');
  cleaned = cleaned.replace(/(?:<div[^>]*>)*\s*Topics[\s\S]*$/gi, '');
  
  // Remove tab elements and custom hint components
  cleaned = cleaned.replace(/<[a-z]+-tabs[^>]*>[\s\S]*?<\/[a-z]+-tabs>/gi, '');
  cleaned = cleaned.replace(/<app-hint[^>]*>[\s\S]*?<\/app-hint>/gi, '');
  
  // Remove hidden buttons and elements
  cleaned = cleaned.replace(/<button[^>]*style="[^"]*display:\s*none[^"]*"[^>]*>[\s\S]*?<\/button>/gi, '');
  cleaned = cleaned.replace(/<[a-z]+-[^>]*style="[^"]*display:\s*none[^"]*"[^>]*>[\s\S]*?<\/[a-z]+-[^>]*>/gi, '');
  
  cleaned = cleaned.trim();
  
  return cleaned;
}

function buildFolder(submission: SubmissionPayload): string {
  // Add leading zeros to problem number like LeetCode: 0049-problem-name
  const number = submission.problemNumber || '';
  const paddedNumber = number ? number.padStart(4, '0') : '';
  const folderName = paddedNumber ? `${paddedNumber}-${submission.slug}` : submission.slug;
  return `${BASE_PATH}/${folderName}`;
}

function buildCodePath(submission: SubmissionPayload): string {
  // Add leading zeros to filename like LeetCode: 0049-problem-name.java
  const number = submission.problemNumber || '';
  const paddedNumber = number ? number.padStart(4, '0') : '';
  const baseName = paddedNumber ? `${paddedNumber}-${submission.slug}` : submission.slug;
  const filename = `${baseName}.${extensionFor(submission.language)}`;
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
  if (normalized.includes('python') || normalized === 'py') return 'py';
  if (normalized.includes('java') || normalized === 'java') return 'java';
  if (normalized.includes('cpp') || normalized === 'c++' || normalized === 'cpp') return 'cpp';
  if (normalized.includes('javascript') || normalized.includes('node') || normalized === 'js') return 'js';
  if (normalized.includes('typescript') || normalized === 'ts') return 'ts';
  if (normalized.includes('c#') || normalized === 'csharp' || normalized === 'cs') return 'cs';
  if (normalized.includes('go') || normalized === 'golang') return 'go';
  if (normalized.includes('ruby') || normalized === 'rb') return 'rb';
  if (normalized.includes('swift')) return 'swift';
  if (normalized.includes('kotlin') || normalized === 'kt') return 'kt';
  if (normalized.includes('rust') || normalized === 'rs') return 'rs';
  if (normalized === 'c') return 'c';
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
