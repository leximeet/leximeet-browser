export function cleanTestResources(options?: {
  root?: string;
  apply?: boolean;
  commands?: () => string;
}): { applied: boolean; bytes: number; targets: { name: string; bytes: number }[] };
