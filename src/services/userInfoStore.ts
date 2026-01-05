import * as fs from "fs/promises";
import * as path from "path";
import { config } from "../config";

export interface UserInfo {
  userId: string;
  pronouns?: string;
  bio?: string;
  updatedAt: string;
}

interface UserInfoData {
  users: Record<string, UserInfo>;
}

export class UserInfoStore {
  private static instance: UserInfoStore;
  private data: UserInfoData = { users: {} };
  private filePath: string;
  private loaded = false;

  private constructor() {
    this.filePath = path.join(config.memory.dataDir, "user-info.json");
  }

  static getInstance(): UserInfoStore {
    if (!UserInfoStore.instance) {
      UserInfoStore.instance = new UserInfoStore();
    }
    return UserInfoStore.instance;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;

    try {
      const content = await fs.readFile(this.filePath, "utf-8");
      this.data = JSON.parse(content);
      console.log(`📋 Loaded user info for ${Object.keys(this.data.users).length} users`);
    } catch (error: any) {
      if (error.code === "ENOENT") {
        // File doesn't exist yet, start with empty data
        this.data = { users: {} };
        console.log("📋 No existing user info found, starting fresh");
      } else {
        console.error("❌ Error loading user info:", error);
        this.data = { users: {} };
      }
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    try {
      // Ensure directory exists
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(this.filePath, JSON.stringify(this.data, null, 2));
    } catch (error) {
      console.error("❌ Error saving user info:", error);
    }
  }

  async setUserInfo(userId: string, info: { pronouns?: string; bio?: string }): Promise<void> {
    await this.ensureLoaded();

    const existing = this.data.users[userId] || { userId };

    this.data.users[userId] = {
      ...existing,
      ...info,
      userId,
      updatedAt: new Date().toISOString(),
    };

    await this.save();
    console.log(`📋 Updated info for user ${userId}`);
  }

  async getUserInfo(userId: string): Promise<UserInfo | null> {
    await this.ensureLoaded();
    return this.data.users[userId] || null;
  }

  async getUserInfoBatch(userIds: string[]): Promise<Map<string, UserInfo>> {
    await this.ensureLoaded();
    const result = new Map<string, UserInfo>();

    for (const userId of userIds) {
      const info = this.data.users[userId];
      if (info) {
        result.set(userId, info);
      }
    }

    return result;
  }

  formatUserInfoForPrompt(
    userInfoMap: Map<string, UserInfo>,
    userIdToName: Map<string, string>,
  ): string {
    if (userInfoMap.size === 0) return "";

    let prompt = "\n\n## User Information\nHere is information about users in this conversation:\n";

    for (const [userId, info] of userInfoMap) {
      const displayName = userIdToName.get(userId) || `User ${userId}`;
      const parts: string[] = [];

      if (info.pronouns) {
        parts.push(`pronouns: ${info.pronouns}`);
      }
      if (info.bio) {
        parts.push(`bio: ${info.bio}`);
      }

      if (parts.length > 0) {
        prompt += `- **${displayName}**: ${parts.join(", ")}\n`;
      }
    }

    return prompt;
  }
}
