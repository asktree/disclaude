export interface FileChange {
  filename: string;
  additions: number;
  deletions: number;
  patch?: string; // The actual diff/patch content
  status: string; // added, modified, removed, etc.
}

export interface GitCommitInfo {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string;
  filesChanged: string[];
  fileDetails?: FileChange[]; // Detailed information about each file
  insertions: number;
  deletions: number;
  githubUrl: string;
}

/**
 * Get information about the latest git commit from GitHub API
 * Falls back to git commands if GitHub API fails
 */
export async function getLatestCommitInfo(): Promise<GitCommitInfo | null> {
  // First try GitHub API (works in production)
  const githubInfo = await getCommitFromGitHub();
  if (githubInfo) return githubInfo;

  // Fallback to git commands (works in development)
  return getCommitFromGit();
}

/**
 * Fetch commit info from GitHub API
 */
async function getCommitFromGitHub(): Promise<GitCommitInfo | null> {
  try {
    // Use environment variable or default to the known repo
    const repoOwner = process.env.GITHUB_OWNER || "asktree";
    const repoName = process.env.GITHUB_REPO || "disclaude";

    // Fetch the latest commit from the main branch
    const commitsUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/commits/main`;

    console.log(`📊 Fetching commit info from GitHub: ${commitsUrl}`);

    const response = await fetch(commitsUrl);
    if (!response.ok) {
      console.log(`⚠️ GitHub API returned ${response.status}`);
      return null;
    }

    const commitData = await response.json() as any;

    // Extract the data we need
    const hash = commitData.sha;
    const shortHash = hash.substring(0, 7);
    const message = commitData.commit.message.split('\n')[0]; // First line only
    const author = commitData.commit.author.name;
    const date = commitData.commit.author.date.split('T')[0]; // YYYY-MM-DD format

    // Get file changes with detailed information
    const fileDetails: FileChange[] = commitData.files?.map((f: any) => ({
      filename: f.filename,
      additions: f.additions || 0,
      deletions: f.deletions || 0,
      patch: f.patch, // Contains the actual diff
      status: f.status, // added, modified, removed, etc.
    })) || [];

    const filesChanged = fileDetails.map(f => f.filename);
    const insertions = commitData.stats?.additions || 0;
    const deletions = commitData.stats?.deletions || 0;

    const githubUrl = commitData.html_url;

    console.log(`✅ Successfully fetched commit ${shortHash} from GitHub`);

    return {
      hash,
      shortHash,
      message,
      author,
      date,
      filesChanged,
      fileDetails,
      insertions,
      deletions,
      githubUrl,
    };
  } catch (error) {
    console.error("Error fetching from GitHub API:", error);
    return null;
  }
}

/**
 * Get commit info using local git commands (fallback for development)
 */
async function getCommitFromGit(): Promise<GitCommitInfo | null> {
  try {
    // Only import these if we're actually using git commands
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);

    console.log("📊 Fetching commit info from local git...");

    // Get basic commit info
    const { stdout: commitInfo } = await execAsync(
      'git log -1 --pretty=format:"%H|%h|%s|%an|%ad" --date=short'
    );
    const [hash, shortHash, message, author, date] = commitInfo.split("|");

    // Get changed files and stats
    const { stdout: diffStat } = await execAsync(
      "git diff-tree --no-commit-id --name-only -r HEAD"
    );
    const filesChanged = diffStat
      .split("\n")
      .filter((file) => file.length > 0);

    // Get insertion/deletion stats
    const { stdout: stats } = await execAsync(
      "git log -1 --stat --format="
    );
    let insertions = 0;
    let deletions = 0;

    // Parse the stats line
    const statsMatch = stats.match(/(\d+) insertion.*?(\d+) deletion/);
    if (statsMatch) {
      insertions = parseInt(statsMatch[1]) || 0;
      deletions = parseInt(statsMatch[2]) || 0;
    } else {
      const insertMatch = stats.match(/(\d+) insertion/);
      const deleteMatch = stats.match(/(\d+) deletion/);
      if (insertMatch) insertions = parseInt(insertMatch[1]);
      if (deleteMatch) deletions = parseInt(deleteMatch[1]);
    }

    // Get remote URL and construct GitHub link
    const { stdout: remoteUrl } = await execAsync("git remote get-url origin");
    const githubUrl = constructGitHubUrl(remoteUrl.trim(), hash);

    console.log(`✅ Successfully fetched commit ${shortHash} from git`);

    return {
      hash,
      shortHash,
      message,
      author,
      date,
      filesChanged,
      insertions,
      deletions,
      githubUrl,
    };
  } catch (error: any) {
    // This is expected in production environments
    if (error.message?.includes("git: not found")) {
      console.log("ℹ️ Git not available (this is normal in production)");
    } else {
      console.error("Error getting git commit info:", error);
    }
    return null;
  }
}

/**
 * Convert a git remote URL to a GitHub commit URL
 */
function constructGitHubUrl(remoteUrl: string, commitHash: string): string {
  let repoPath = "";

  if (remoteUrl.startsWith("git@github.com:")) {
    repoPath = remoteUrl.replace("git@github.com:", "").replace(".git", "");
  } else if (remoteUrl.includes("github.com")) {
    const match = remoteUrl.match(/github\.com\/(.+?)(\.git)?$/);
    if (match) {
      repoPath = match[1].replace(".git", "");
    }
  }

  return `https://github.com/${repoPath}/commit/${commitHash}`;
}

/**
 * Generate a detailed natural language summary of the commit changes
 * This function analyzes the actual diffs to provide specific insights
 */
export function generateCommitSummary(commitInfo: GitCommitInfo): string {
  const { message, filesChanged, fileDetails, insertions, deletions } = commitInfo;

  let summary = `**${message}**\n\n`;

  // First, provide a high-level overview
  if (filesChanged.length === 0) {
    summary += "This update includes configuration or deployment changes.\n";
  } else {
    summary += `📝 **Files Modified:** ${filesChanged.length}\n`;
    summary += `📊 **Changes:** +${insertions} additions, -${deletions} deletions\n\n`;
  }

  // Analyze the actual changes if we have detailed file information
  if (fileDetails && fileDetails.length > 0) {
    summary += "## What Changed:\n\n";

    // Group files by their purpose/area
    const groupedFiles: { [key: string]: FileChange[] } = {};

    fileDetails.forEach(file => {
      // Determine the category based on file path and name
      let category = "Other";

      if (file.filename.includes('handler')) {
        category = "Message Handling";
      } else if (file.filename.includes('service')) {
        category = "Services";
      } else if (file.filename.includes('utils')) {
        category = "Utilities";
      } else if (file.filename.includes('config')) {
        category = "Configuration";
      } else if (file.filename.includes('index')) {
        category = "Main Application";
      } else if (file.filename.includes('test')) {
        category = "Tests";
      }

      if (!groupedFiles[category]) {
        groupedFiles[category] = [];
      }
      groupedFiles[category].push(file);
    });

    // Analyze each group
    for (const [category, files] of Object.entries(groupedFiles)) {
      summary += `### ${category}\n`;

      for (const file of files) {
        summary += `- **${file.filename}** (${file.status}): `;

        // Analyze the patch to understand what specifically changed
        if (file.patch) {
          const analysis = analyzePatch(file.patch, file.filename);
          summary += analysis;
        } else {
          // Fallback to basic stats if no patch available
          if (file.status === 'added') {
            summary += `New file with ${file.additions} lines`;
          } else if (file.status === 'removed') {
            summary += `File removed (${file.deletions} lines)`;
          } else {
            summary += `Modified with +${file.additions}/-${file.deletions} lines`;
          }
        }
        summary += "\n";
      }
      summary += "\n";
    }
  }

  // Provide specific technical insights based on the changes
  summary += "## Technical Impact:\n\n";

  // Analyze patterns in the commit message and changes
  const lowerMessage = message.toLowerCase();
  const fullCommitMessage = commitInfo.message; // We might have the full message with body

  if (lowerMessage.includes("fix")) {
    summary += "🔧 **Bug Fix:** ";

    // Try to identify what was fixed
    if (lowerMessage.includes("nickname") || filesChanged.some(f => f.includes("messageFormatter"))) {
      summary += "Resolves issues with user display names in Discord messages. ";
    } else if (lowerMessage.includes("channel")) {
      summary += "Addresses channel-related functionality issues. ";
    } else {
      summary += "Corrects previously broken functionality. ";
    }
    summary += "\n";
  }

  if (lowerMessage.includes("add") || lowerMessage.includes("new")) {
    summary += "✨ **New Feature:** ";

    // Identify what was added based on files and message
    if (lowerMessage.includes("tool")) {
      summary += "Introduces new tool capabilities for the bot. ";
    } else if (lowerMessage.includes("channel")) {
      summary += "Adds channel-related functionality. ";
    } else if (lowerMessage.includes("notification")) {
      summary += "Implements notification system. ";
    } else {
      summary += "Extends bot capabilities with new functionality. ";
    }
    summary += "\n";
  }

  if (lowerMessage.includes("improve") || lowerMessage.includes("enhance") || lowerMessage.includes("update")) {
    summary += "🚀 **Enhancement:** ";

    // Identify what was improved
    if (fileDetails) {
      const majorChanges = fileDetails.filter(f => f.additions + f.deletions > 50);
      if (majorChanges.length > 0) {
        summary += `Significant improvements to ${majorChanges.map(f => getFileDescription(f.filename)).join(", ")}. `;
      } else {
        summary += "Minor improvements and optimizations. ";
      }
    }
    summary += "\n";
  }

  if (lowerMessage.includes("refactor")) {
    summary += "♻️ **Refactoring:** Code structure improved for better maintainability. \n";
  }

  // Add deployment/runtime considerations
  summary += "\n## Deployment Notes:\n";

  if (filesChanged.some(f => f.includes('config') || f.includes('.env'))) {
    summary += "⚠️ Configuration changes may require environment variable updates.\n";
  }

  if (filesChanged.some(f => f.includes('package.json'))) {
    summary += "📦 Dependencies changed - run `pnpm install` after pulling.\n";
  }

  if (insertions > 100 || deletions > 100) {
    summary += "📈 Substantial code changes - thorough testing recommended.\n";
  }

  return summary;
}

/**
 * Analyze a patch/diff to understand what specifically changed
 * This provides detailed insights about the actual code changes
 */
function analyzePatch(patch: string, filename: string): string {
  const lines = patch.split('\n');
  const addedLines = lines.filter(l => l.startsWith('+') && !l.startsWith('+++'));
  const removedLines = lines.filter(l => l.startsWith('-') && !l.startsWith('---'));

  // Look for specific patterns in the changes
  const addedContent = addedLines.join('\n');
  const removedContent = removedLines.join('\n');

  let analysis = "";

  // Detect what type of changes were made
  if (addedLines.length === 0 && removedLines.length > 0) {
    analysis = "Removed code";
  } else if (removedLines.length === 0 && addedLines.length > 0) {
    // Analyze what was added
    if (addedContent.includes('async') || addedContent.includes('await')) {
      analysis = "Added asynchronous functionality";
    } else if (addedContent.includes('function') || addedContent.includes('=>')) {
      analysis = "Added new function/method";
    } else if (addedContent.includes('if') || addedContent.includes('else')) {
      analysis = "Added conditional logic";
    } else if (addedContent.includes('console.log')) {
      analysis = "Added logging";
    } else if (addedContent.includes('try') || addedContent.includes('catch')) {
      analysis = "Added error handling";
    } else if (addedContent.includes('import') || addedContent.includes('require')) {
      analysis = "Added new dependencies/imports";
    } else {
      analysis = "Added new code";
    }
  } else {
    // Both additions and removals - it's a modification
    // Try to understand the nature of the modification
    if (addedContent.includes('await') && !removedContent.includes('await')) {
      analysis = "Made function asynchronous";
    } else if (filename.includes('.ts') || filename.includes('.js')) {
      // Analyze code changes
      if (addedLines.length > removedLines.length * 2) {
        analysis = "Expanded functionality significantly";
      } else if (removedLines.length > addedLines.length * 2) {
        analysis = "Simplified/reduced code";
      } else {
        // Look for specific patterns
        if (addedContent.includes('fetch') || addedContent.includes('.get(')) {
          analysis = "Modified data fetching logic";
        } else if (addedContent.includes('.member') || addedContent.includes('displayName')) {
          analysis = "Changed user/member handling";
        } else if (addedContent.includes('channel')) {
          analysis = "Modified channel-related logic";
        } else {
          analysis = "Refactored existing logic";
        }
      }
    } else {
      analysis = `Modified with +${addedLines.length}/-${removedLines.length} lines`;
    }
  }

  return analysis;
}

/**
 * Get a human-readable description of what a file does based on its name/path
 */
function getFileDescription(filename: string): string {
  const name = filename.split('/').pop() || filename;

  if (name.includes('handler')) return "message handling";
  if (name.includes('service')) return "service layer";
  if (name.includes('formatter')) return "formatting logic";
  if (name.includes('config')) return "configuration";
  if (name.includes('utils')) return "utility functions";
  if (name === 'index.ts' || name === 'index.js') return "main application";

  return name.replace(/\.(ts|js|json)$/, '');
}