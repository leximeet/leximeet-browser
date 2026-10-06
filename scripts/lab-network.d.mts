export function labProxy(
  env?: Record<string, string | undefined>,
  probe?: (port: number) => Promise<boolean>,
): Promise<{ server: string; bypass: string } | undefined>;
