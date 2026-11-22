export function disabledManagedCatalog(
  input: RequestInfo | URL,
  init?: RequestInit,
): Response | undefined {
  if (String(input) !== '/plugins/managed' || init?.method !== 'GET') return undefined;
  return Response.json(
    { error: { code: 'plugin-installer-disabled', message: 'Installer disabled' } },
    { status: 404 },
  );
}
