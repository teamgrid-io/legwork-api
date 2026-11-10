import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";

export interface FileStorage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

function assertSafeKey(key: string): void {
  if (
    key.includes("..") ||
    key.includes("/") ||
    key.includes("\\")
  ) {
    throw new Error("Invalid storage key");
  }
}

export class LocalDiskStorage implements FileStorage {
  constructor(private readonly directory: string) {}

  private resolve(key: string): string {
    assertSafeKey(key);

    return join(this.directory, key);
  }

  async put(key: string, data: Buffer): Promise<void> {
    const path = this.resolve(key);

    await mkdir(this.directory, { recursive: true });
    await writeFile(path, data);
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.resolve(key));
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.resolve(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
}

export const storage: FileStorage = new LocalDiskStorage(config.uploadDir);
