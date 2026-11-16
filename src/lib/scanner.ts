// DEVELOPMENT STUB. Replace with ClamAV before launch.
export interface Scanner {
  scan(data: Buffer): Promise<{ clean: boolean; reason?: string }>;
}

const MAX_SCAN_BYTES = 5 * 1024 * 1024;

const stub: Scanner = {
  async scan(data: Buffer): Promise<{ clean: boolean; reason?: string }> {
    if (data.length === 0 || data.length >= MAX_SCAN_BYTES) {
      return { clean: false, reason: "File failed security check" };
    }

    return { clean: true };
  },
};

export const scanner: Scanner = stub;
