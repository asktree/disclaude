import Anthropic from "@anthropic-ai/sdk";

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

    const commitData = (await response.json()) as any;

    // Extract the data we need
    const hash = commitData.sha;
    const shortHash = hash.substring(0, 7);
    const message = commitData.commit.message.split("\n")[0]; // First line only
    const author = commitData.commit.author.name;
    const date = commitData.commit.author.date.split("T")[0]; // YYYY-MM-DD format

    // Get file changes with detailed information
    const fileDetails: FileChange[] =
      commitData.files?.map((f: any) => ({
        filename: f.filename,
        additions: f.additions || 0,
        deletions: f.deletions || 0,
        patch: f.patch, // Contains the actual diff
        status: f.status, // added, modified, removed, etc.
      })) || [];

    const filesChanged = fileDetails.map((f) => f.filename);
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
      'git log -1 --pretty=format:"%H|%h|%s|%an|%ad" --date=short',
    );
    const [hash, shortHash, message, author, date] = commitInfo.split("|");

    // Get changed files and stats
    const { stdout: diffStat } = await execAsync(
      "git diff-tree --no-commit-id --name-only -r HEAD",
    );
    const filesChanged = diffStat.split("\n").filter((file) => file.length > 0);

    // Get insertion/deletion stats
    const { stdout: stats } = await execAsync("git log -1 --stat --format=");
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
 * Generate a commit summary by using Claude to analyze the diffs
 * This sends the actual code changes to Claude for intelligent analysis
 */
export async function generateCommitSummary(commitInfo: GitCommitInfo): Promise<string> {
  const { message, filesChanged, fileDetails, insertions, deletions } = commitInfo;

  // Compact stats line
  const statsLine = `*📝 ${filesChanged.length} files | +${insertions}/-${deletions}*`;

  // If we don't have file details with patches, return a simple summary
  if (!fileDetails || fileDetails.length === 0) {
    return `**${message}**\n\n${statsLine}`;
  }

  // Prepare the diff content for Claude
  let diffContent = `Commit Message: ${message}\n\n`;
  diffContent += `Stats: ${filesChanged.length} files changed, +${insertions} additions, -${deletions} deletions\n\n`;
  diffContent += "=== DIFFS ===\n\n";

  // Add each file's diff
  for (const file of fileDetails) {
    diffContent += `File: ${file.filename} (${file.status})\n`;
    diffContent += `Changes: +${file.additions}/-${file.deletions}\n`;

    if (file.patch) {
      // Include the actual diff patch (limited to reasonable size)
      const patchLines = file.patch.split("\n").slice(0, 100); // Limit to first 100 lines per file
      diffContent += "```diff\n" + patchLines.join("\n") + "\n```\n\n";
    }
  }

  // Use Claude API to analyze the diffs
  try {
    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY || "",
    });

    const response = await anthropic.messages.create({
      model: "claude-3-haiku-20240307", // Use Haiku for speed and cost efficiency
      max_tokens: 200,
      messages: [
        {
          role: "user",
          content: `Look at this git commit and:
1. Write ONE concise paragraph explaining what changed and why it matters
2. Check for any CRITICAL bugs, security issues, or problems in the code changes

${diffContent}

Format your response as one short paragraph (2-3 sentences) capturing the essence of this change.

Also: If (AND ONLY IF!!!!) you spot any critical issues, add a line starting with "⚠️ WARNING:" followed by a brief description. Focus on actual functionality impact and real problems only. Don't mention minor style issues. 
`,
        },
      ],
    });

    const summary = response.content[0].type === "text" ? response.content[0].text : "";
    return `**${message}**\n\n${statsLine}\n\n${summary}`;
  } catch (error) {
    console.error("Failed to generate AI summary:", error);
    // Fallback to basic summary if API fails
    return `**${message}**\n\n${statsLine}\n\nFiles changed: ${filesChanged.join(", ")}`;
  }
}
