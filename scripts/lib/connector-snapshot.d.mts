export function verifyConnectorSnapshot(directory: string): {
  snapshot: {
    contractVersion: string;
    contractDigest: string;
    sourceCommit: string;
    files: { path: string; sha256: string }[];
  };
  contract: { packageVersion: string; contractDigest: string; [key: string]: unknown };
  manifest: { files: { path: string; sha256: string }[]; [key: string]: unknown };
};
