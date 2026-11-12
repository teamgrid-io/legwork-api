import { readFile } from "node:fs/promises";

// DEVELOPMENT STUB. Replace with ClamAV before launch.
export interface Scanner {
  scan(path: string): Promise<{ clean: boolean; reason?: string }>;
}

const MAX_SCAN_BYTES = 5 * 1024 * 1024;

const stub: Scanner = {
  async scan(path: string): Promise<{ clean: boolean; reason?: string }> {
    try {
      const data = await readFile(path);

      if (data.length >= MAX_SCAN_BYTES) {
        return { clean: false, reason: "Unreadable file" };
      }

      return { clean: true };
    } catch {
      return { clean: false, reason: "Unreadable file" };
    }
  },
};

export const scanner: Scanner = stub;
