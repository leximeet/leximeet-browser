export function uploadOperationId(
  location: string | null,
  productId: string,
  kind?: "upload" | "submission",
): string;
export function uploadEdgeDraft(options: {
  packagePath: string;
  expectedSha256: string;
  productId: string;
  clientId: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxPolls?: number;
  resumeUploadOperationId?: string;
}): Promise<{ status: "Succeeded"; operationId: string; sha256: string }>;
