import { error, log } from './logger';
import type { RepoConfig } from './storage';

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

const BASE_PATH = '';

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
  return BASE_PATH ? `${BASE_PATH}/${folderName}` : folderName;
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
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const ok = response.ok;
  const status = response.status;
  const data = ok ? ((await response.json()) as T) : undefined;
  return { ok, status, data, text: () => response.text() };
}
