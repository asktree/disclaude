import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export interface GitCommitInfo {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string;
  filesChanged: string[];
  insertions: number;
  deletions: number;
  githubUrl: string;
}

/**
 * Get information about the latest git commit
 */
export async function getLatestCommitInfo(): Promise<GitCommitInfo | null> {
  try {
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

    // Parse the stats line (e.g., "3 files changed, 45 insertions(+), 12 deletions(-)")
    const statsMatch = stats.match(/(\d+) insertion.*?(\d+) deletion/);
    if (statsMatch) {
      insertions = parseInt(statsMatch[1]) || 0;
      deletions = parseInt(statsMatch[2]) || 0;
    } else {
      // Check for only insertions or only deletions
      const insertMatch = stats.match(/(\d+) insertion/);
      const deleteMatch = stats.match(/(\d+) deletion/);
      if (insertMatch) insertions = parseInt(insertMatch[1]);
      if (deleteMatch) deletions = parseInt(deleteMatch[1]);
    }

    // Get remote URL and construct GitHub link
    const { stdout: remoteUrl } = await execAsync("git remote get-url origin");
    const githubUrl = constructGitHubUrl(remoteUrl.trim(), hash);

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
  } catch (error) {
    console.error("Error getting git commit info:", error);
    return null;
  }
}

/**
 * Convert a git remote URL to a GitHub commit URL
 */
function constructGitHubUrl(remoteUrl: string, commitHash: string): string {
  // Handle both SSH and HTTPS URLs
  let repoPath = "";

  if (remoteUrl.startsWith("git@github.com:")) {
    // SSH format: git@github.com:user/repo.git
    repoPath = remoteUrl.replace("git@github.com:", "").replace(".git", "");
  } else if (remoteUrl.includes("github.com")) {
    // HTTPS format: https://github.com/user/repo.git
    const match = remoteUrl.match(/github\.com\/(.+?)(\.git)?$/);
    if (match) {
      repoPath = match[1].replace(".git", "");
    }
  }

  return `https://github.com/${repoPath}/commit/${commitHash}`;
}

/**
 * Generate a natural language summary of the commit changes
 */
export function generateCommitSummary(commitInfo: GitCommitInfo): string {
  const { message, filesChanged, insertions, deletions, author } = commitInfo;

  let summary = `**${message}**\n\n`;

  // Describe the scope of changes
  if (filesChanged.length === 1) {
    summary += `This update modifies \`${filesChanged[0]}\``;
  } else if (filesChanged.length <= 3) {
    summary += `This update modifies ${filesChanged.length} files: ${filesChanged
      .map((f) => `\`${f}\``)
      .join(", ")}`;
  } else {
    summary += `This update modifies ${filesChanged.length} files`;

    // Group by directory for large changes
    const directories = new Set(
      filesChanged
        .map((f) => f.split("/")[0])
        .filter((d) => d !== "")
    );
    if (directories.size <= 3) {
      summary += ` across ${Array.from(directories)
        .map((d) => `\`${d}/\``)
        .join(", ")}`;
    }
  }

  // Add stats
  if (insertions > 0 || deletions > 0) {
    summary += ` with `;
    const changes = [];
    if (insertions > 0) changes.push(`+${insertions} additions`);
    if (deletions > 0) changes.push(`-${deletions} deletions`);
    summary += changes.join(" and ");
  }

  summary += ".";

  // Try to infer what the change does based on the commit message and files
  const lowerMessage = message.toLowerCase();

  if (lowerMessage.includes("fix")) {
    summary += "\n\nThis appears to be a bug fix. ";
  } else if (lowerMessage.includes("add") || lowerMessage.includes("new")) {
    summary += "\n\nThis adds new functionality. ";
  } else if (lowerMessage.includes("update") || lowerMessage.includes("improve")) {
    summary += "\n\nThis improves existing functionality. ";
  } else if (lowerMessage.includes("refactor")) {
    summary += "\n\nThis refactors code for better structure. ";
  }

  // Add specific interpretations based on files changed
  if (filesChanged.some((f) => f.includes("messageFormatter"))) {
    summary += "The changes affect how Discord messages are formatted and displayed. ";
  }
  if (filesChanged.some((f) => f.includes("handler"))) {
    summary += "The changes affect message handling logic. ";
  }
  if (filesChanged.some((f) => f.includes("config"))) {
    summary += "Configuration settings have been modified. ";
  }

  return summary;
}