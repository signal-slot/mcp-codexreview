#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError
} from '@modelcontextprotocol/sdk/types.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

const execFileAsync = promisify(execFile);

type DiffType = 'unstaged' | 'staged' | 'last_commit';

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'build', 'dist', '.target',
  'coverage', '__pycache__', '.next', 'vendor',
]);

const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
  '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.o', '.a', '.lib',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv',
  '.pyc', '.pyo', '.class', '.jar', '.war',
]);

async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

async function collectFiles(dir: string, base?: string): Promise<string[]> {
  const root = base ?? dir;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;

    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(full, root));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      // skip binary and extensionless dotfiles like .DS_Store
      if (BINARY_EXTS.has(ext)) continue;
      if (ext === '' && entry.name.startsWith('.')) continue;
      files.push(path.relative(root, full));
    }
  }

  return base === undefined ? files.sort() : files;
}

const VALID_DIFF_TYPES = new Set<string>(['unstaged', 'staged', 'last_commit']);

function validateDiffType(type: unknown): DiffType {
  if (type !== undefined && !VALID_DIFF_TYPES.has(type as string)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid type "${type}". Must be one of: unstaged, staged, last_commit`
    );
  }
  return (type as DiffType) || 'unstaged';
}

const REVIEW_CRITERIA = `- Correctness and potential bugs
- Code style and readability
- Performance considerations
- Security concerns
- Suggestions for improvement`;

async function hasParentCommit(cwd: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', 'HEAD~1'], { cwd });
    return true;
  } catch {
    return false;
  }
}

async function emptyTreeSha(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['hash-object', '-t', 'tree', '/dev/null'], { cwd });
  return stdout.trim();
}

async function gitDiffArgs(type: DiffType, nameStatusOnly: boolean, useRootDiff: boolean, cwd: string, filePath?: string): Promise<string[]> {
  const args = ['diff'];
  if (nameStatusOnly) args.push('--name-status');
  switch (type) {
    case 'unstaged':
      break;
    case 'staged':
      args.push('--cached');
      break;
    case 'last_commit':
      if (useRootDiff) {
        args.push(await emptyTreeSha(cwd), 'HEAD');
      } else {
        args.push('HEAD~1', 'HEAD');
      }
      break;
  }
  if (filePath) args.push('--', filePath);
  return args;
}

function diffTypeLabel(type: DiffType): string {
  switch (type) {
    case 'unstaged': return 'unstaged';
    case 'staged': return 'staged';
    case 'last_commit': return 'last commit';
  }
}

async function diffGitCommand(type: DiffType, cwd: string, useRootDiff = false): Promise<string> {
  switch (type) {
    case 'unstaged': return 'git diff';
    case 'staged': return 'git diff --cached';
    case 'last_commit':
      return useRootDiff
        ? `git diff ${await emptyTreeSha(cwd)} HEAD`
        : 'git diff HEAD~1 HEAD';
  }
}

class CodexReviewServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      {
        name: 'mcp-codexreview',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();

    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'review_changes',
          description: 'Review code using OpenAI Codex. Works with git repos (reviews diff) or plain directories (reviews all source files).',
          inputSchema: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['unstaged', 'staged', 'last_commit'],
                description: 'Which changes to review: unstaged working-tree changes, staged (cached) changes, or the last commit. Only used for git repos.'
              },
              cwd: {
                type: 'string',
                description: 'Path to the directory or git repository (defaults to server working directory)'
              },
              model: {
                type: 'string',
                description: 'Override the Codex model (e.g. "o3", "gpt-4.1")'
              },
              instructions: {
                type: 'string',
                description: 'Additional review focus or instructions to append to the review prompt'
              }
            }
          }
        },
        {
          name: 'get_diff',
          description: 'Get diff output. For git repos returns git diff; for plain directories returns file contents in unified diff format.',
          inputSchema: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['unstaged', 'staged', 'last_commit'],
                description: 'Which changes to diff. Only used for git repos.'
              },
              path: {
                type: 'string',
                description: 'Filter diff to a specific file or directory'
              },
              cwd: {
                type: 'string',
                description: 'Path to the directory or git repository (defaults to server working directory)'
              }
            }
          }
        },
        {
          name: 'get_changed_files',
          description: 'List files. For git repos lists changed files; for plain directories lists all source files as added.',
          inputSchema: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['unstaged', 'staged', 'last_commit'],
                description: 'Which changes to list. Only used for git repos.'
              },
              cwd: {
                type: 'string',
                description: 'Path to the directory or git repository (defaults to server working directory)'
              }
            }
          }
        }
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const args = request.params.arguments ?? {};
      switch (request.params.name) {
        case 'review_changes':
          return await this.handleReviewChanges(args);
        case 'get_diff':
          return await this.handleGetDiff(args);
        case 'get_changed_files':
          return await this.handleGetChangedFiles(args);
        default:
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${request.params.name}`
          );
      }
    });
  }

  private async handleReviewChanges(args: any) {
    const cwd = args.cwd || process.cwd();
    const type = validateDiffType(args.type);
    const model: string | undefined = args.model;
    const instructions: string | undefined = args.instructions;
    const git = await isGitRepo(cwd);

    let prompt: string;
    if (git) {
      const rootDiff = type === 'last_commit' && !(await hasParentCommit(cwd));
      const label = diffTypeLabel(type);
      const gitCmd = await diffGitCommand(type, cwd, rootDiff);
      prompt = `Review the current ${label} changes in this git repository. Run \`${gitCmd}\` to see the changes, then provide a thorough code review covering:\n${REVIEW_CRITERIA}`;
    } else {
      prompt = `Review all source code files in this directory. Read the files and provide a thorough code review covering:\n${REVIEW_CRITERIA}`;
    }

    if (instructions) {
      prompt += `\n\nAdditional instructions: ${instructions}`;
    }

    try {
      const review = await this.runCodexReview(prompt, cwd, model, !git);
      return {
        content: [
          {
            type: 'text',
            text: review
          }
        ]
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: 'text',
            text: `Codex review failed: ${errorMessage}`
          }
        ],
        isError: true
      };
    }
  }

  private async handleGetDiff(args: any) {
    const cwd = args.cwd || process.cwd();
    const type = validateDiffType(args.type);
    const filePath: string | undefined = args.path;
    const git = await isGitRepo(cwd);

    try {
      if (git) {
        const rootDiff = type === 'last_commit' && !(await hasParentCommit(cwd));
        const gitArgs = await gitDiffArgs(type, false, rootDiff, cwd, filePath);
        const { stdout } = await execFileAsync('git', gitArgs, { cwd, maxBuffer: 50 * 1024 * 1024 });

        if (!stdout.trim()) {
          return {
            content: [
              {
                type: 'text',
                text: `No ${diffTypeLabel(type)} changes found${filePath ? ` for ${filePath}` : ''}.`
              }
            ]
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: stdout
            }
          ]
        };
      }

      // Non-git: produce unified diff showing all file contents as additions
      let files = await collectFiles(cwd);
      if (filePath) {
        files = files.filter(f => f === filePath || f.startsWith(filePath + '/'));
      }

      if (files.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No source files found${filePath ? ` matching ${filePath}` : ''}.`
            }
          ]
        };
      }

      const chunks: string[] = [];
      for (const file of files) {
        const content = await fs.readFile(path.join(cwd, file), 'utf-8');
        const lines = content.split('\n');
        // Remove trailing empty line from final newline
        if (lines.length > 0 && lines[lines.length - 1] === '') {
          lines.pop();
        }
        chunks.push(
          `--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n` +
          lines.map(l => `+${l}`).join('\n')
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: chunks.join('\n')
          }
        ]
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: 'text',
            text: `Failed to get diff: ${errorMessage}`
          }
        ],
        isError: true
      };
    }
  }

  private async handleGetChangedFiles(args: any) {
    const cwd = args.cwd || process.cwd();
    const type = validateDiffType(args.type);
    const git = await isGitRepo(cwd);

    try {
      if (git) {
        const rootDiff = type === 'last_commit' && !(await hasParentCommit(cwd));
        const gitArgs = await gitDiffArgs(type, true, rootDiff, cwd);
        const { stdout } = await execFileAsync('git', gitArgs, { cwd, maxBuffer: 10 * 1024 * 1024 });

        if (!stdout.trim()) {
          return {
            content: [
              {
                type: 'text',
                text: `No ${diffTypeLabel(type)} changes found.`
              }
            ]
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: stdout
            }
          ]
        };
      }

      // Non-git: list all source files as added
      const files = await collectFiles(cwd);

      if (files.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: 'No source files found.'
            }
          ]
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: files.map(f => `A\t${f}`).join('\n') + '\n'
          }
        ]
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: 'text',
            text: `Failed to list changed files: ${errorMessage}`
          }
        ],
        isError: true
      };
    }
  }

  private async runCodexReview(prompt: string, cwd: string, model?: string, skipGitRepoCheck?: boolean): Promise<string> {
    const tmpFile = path.join(os.tmpdir(), `codex-review-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
    try {
      const args = [
        'exec', prompt,
        '-C', cwd,
        '-s', 'read-only',
        '--output-last-message', tmpFile,
        '--color', 'never'
      ];
      if (model) {
        args.push('-m', model);
      }
      if (skipGitRepoCheck) {
        args.push('--skip-git-repo-check');
      }

      await execFileAsync('codex', args, {
        timeout: 300000,  // 5 minutes
        maxBuffer: 50 * 1024 * 1024,
        env: { ...process.env },
      });

      return await fs.readFile(tmpFile, 'utf-8');
    } finally {
      await fs.unlink(tmpFile).catch(() => {});
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Codex Review MCP server running on stdio');
  }
}

const server = new CodexReviewServer();
server.run().catch((error) => {
  console.error('Failed to start Codex Review MCP server:', error);
  process.exit(1);
});
