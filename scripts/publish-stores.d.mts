type RequestOptions = {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxPolls?: number;
};
type PackageOptions = RequestOptions & {
  packagePath: string;
  expectedSha256: string;
  version: string;
};
export function chromeAccessToken(
  serviceAccountJson: string,
  fetchImpl?: typeof fetch,
  now?: number,
): Promise<string>;
export function publishChrome(
  options: PackageOptions & {
    publisherId: string;
    extensionId: string;
    accessToken: string;
  },
): Promise<{ state: string; alreadySubmitted: boolean; version: string }>;
export function publishEdge(
  options: PackageOptions & {
    productId: string;
    clientId: string;
    apiKey: string;
    notes: string;
    resumeUploadOperationId?: string;
  },
): Promise<{ state: string; operationId: string; uploadOperationId: string }>;
