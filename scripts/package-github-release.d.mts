export interface ReleaseFile {
  file: string;
  bytes: number;
  sha256: string;
}
export interface StoreEvidence {
  version: string;
  sourceCommit: string;
  sourceDirty: boolean;
  equivalence: boolean;
  productionDigest: string;
  productionFiles: number;
  packages: Partial<Record<"chrome" | "edge", ReleaseFile>>;
}
export function verifyPackages(
  directory: string,
  evidence: StoreEvidence,
  tag: string,
  commit: string,
): ReleaseFile[];
export function packageRelease(
  directory: string,
  output: string,
  tag?: string,
): Record<string, unknown>;
