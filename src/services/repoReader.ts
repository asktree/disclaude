interface GitHubFile {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size?: number;
}

export class RepoReader {
  private repoOwner: string = 'asktree';
  private repoName: string = 'disclaude';
  private baseUrl: string = 'https://api.github.com';
  private rawUrl: string = 'https://raw.githubusercontent.com';

  async getRepoStructure(): Promise<string> {
    try {
      const structure = await this.fetchDirectoryContents('');
      return this.formatStructure(structure);
    } catch (error) {
      console.error('Error fetching repo structure:', error);
      return 'Unable to fetch repository structure';
    }
  }

  async getFileContent(filePath: string): Promise<string> {
    try {
      const url = `${this.rawUrl}/${this.repoOwner}/${this.repoName}/main/${filePath}`;
      const response = await fetch(url);

      if (!response.ok) {
        return `File not found: ${filePath}`;
      }

      const content = await response.text();
      return content;
    } catch (error) {
      console.error(`Error fetching file ${filePath}:`, error);
      return `Unable to fetch file: ${filePath}`;
    }
  }

  private async fetchDirectoryContents(path: string): Promise<GitHubFile[]> {
    const url = `${this.baseUrl}/repos/${this.repoOwner}/${this.repoName}/contents/${path}`;

    try {
      const response = await fetch(url, {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          // Add GitHub token if rate limited (optional)
          // 'Authorization': `token ${process.env.GITHUB_TOKEN}`
        }
      });

      if (!response.ok) {
        throw new Error(`GitHub API error: ${response.status}`);
      }

      const data = await response.json();
      return data.map((item: any) => ({
        name: item.name,
        path: item.path,
        type: item.type,
        size: item.size
      }));
    } catch (error) {
      console.error(`Error fetching directory ${path}:`, error);
      return [];
    }
  }

  private formatStructure(files: GitHubFile[], indent: string = ''): string {
    let structure = '';

    // Sort files: directories first, then files
    files.sort((a, b) => {
      if (a.type === 'dir' && b.type === 'file') return -1;
      if (a.type === 'file' && b.type === 'dir') return 1;
      return a.name.localeCompare(b.name);
    });

    for (const file of files) {
      if (file.type === 'dir') {
        structure += `${indent}📁 ${file.name}/\n`;
      } else {
        const icon = this.getFileIcon(file.name);
        structure += `${indent}${icon} ${file.name}\n`;
      }
    }

    return structure;
  }

  private getFileIcon(filename: string): string {
    if (filename.endsWith('.ts')) return '📄';
    if (filename.endsWith('.js')) return '📜';
    if (filename.endsWith('.json')) return '📋';
    if (filename.endsWith('.md')) return '📝';
    if (filename.endsWith('.yml') || filename.endsWith('.yaml')) return '⚙️';
    if (filename.startsWith('.')) return '🔧';
    return '📄';
  }

  async getRelevantFiles(query: string): Promise<{ path: string; content: string }[]> {
    // Determine which files might be relevant based on the query
    const relevantPaths: string[] = [];

    // Common files that explain the bot
    if (query.toLowerCase().includes('how') || query.toLowerCase().includes('work')) {
      relevantPaths.push(
        'src/index.ts',
        'src/handlers/messageHandler.ts',
        'src/services/contextManager.ts',
        'README.md'
      );
    }

    if (query.toLowerCase().includes('config') || query.toLowerCase().includes('setting')) {
      relevantPaths.push('src/config.ts', '.env.example');
    }

    if (query.toLowerCase().includes('claude') || query.toLowerCase().includes('api')) {
      relevantPaths.push('src/services/claude.ts');
    }

    if (query.toLowerCase().includes('deploy')) {
      relevantPaths.push('Dockerfile', 'railway.toml', 'render.yaml');
    }

    // Fetch the content of relevant files
    const files = await Promise.all(
      relevantPaths.map(async (path) => ({
        path,
        content: await this.getFileContent(path)
      }))
    );

    return files.filter(f => !f.content.startsWith('File not found') && !f.content.startsWith('Unable to fetch'));
  }

  async getRelevantFilesByTopics(topics: string[]): Promise<{ path: string; content: string }[]> {
    const relevantPaths = new Set<string>();

    // Map topics to relevant files
    const topicFileMap: Record<string, string[]> = {
      implementation: ['src/index.ts', 'src/handlers/messageHandler.ts', 'README.md'],
      config: ['src/config.ts', '.env.example', 'tsconfig.json'],
      deployment: ['Dockerfile', 'docker-compose.yml', 'railway.toml', 'render.yaml'],
      api: ['src/services/claude.ts', 'src/services/repoReader.ts'],
      monitoring: ['src/services/contextManager.ts', 'src/handlers/messageHandler.ts'],
      architecture: ['src/index.ts', 'README.md', 'package.json'],
      'message-handling': ['src/handlers/messageHandler.ts'],
      'context': ['src/services/contextManager.ts'],
      'discord': ['src/index.ts', 'src/handlers/messageHandler.ts'],
      'follow-up': ['src/services/contextManager.ts', 'src/handlers/messageHandler.ts'],
    };

    // Add relevant files based on topics
    for (const topic of topics) {
      const files = topicFileMap[topic.toLowerCase()] || [];
      files.forEach(file => relevantPaths.add(file));
    }

    // If no specific files found, add basic implementation files
    if (relevantPaths.size === 0) {
      relevantPaths.add('src/index.ts');
      relevantPaths.add('README.md');
    }

    // Fetch the content of relevant files
    const files = await Promise.all(
      Array.from(relevantPaths).map(async (path) => ({
        path,
        content: await this.getFileContent(path)
      }))
    );

    return files.filter(f => !f.content.startsWith('File not found') && !f.content.startsWith('Unable to fetch'));
  }
}