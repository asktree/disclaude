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

    // Get file changes
    const filesChanged = commitData.files?.map((f: any) => f.filename) || [];
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
 * Generate a natural language summary of the commit changes
 */
export function generateCommitSummary(commitInfo: GitCommitInfo): string {
  const { message, filesChanged, insertions, deletions } = commitInfo;

  let summary = `**${message}**\n\n`;

  // Describe the scope of changes
  if (filesChanged.length === 0) {
    summary += "This update includes configuration or deployment changes.";
  } else if (filesChanged.length === 1) {
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
    summary += ".";
  } else if (filesChanged.length > 0) {
    summary += ".";
  }

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
  if (filesChanged.some((f) => f.includes("gitInfo"))) {
    summary += "The commit notification system has been updated. ";
  }

  return summary;
}