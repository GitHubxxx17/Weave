/**
 * Whether a path names an environment file that commonly holds secrets: a file
 * called `.env` or starting with `.env.`, in any directory. The match is
 * case-sensitive, like the retrieval index exclusion. Both `/` and `\`
 * separate directories so a Windows-style input path is judged by its name.
 */
export function isSecretFile(file: string): boolean {
  const name = file.slice(Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')) + 1);
  return name === '.env' || name.startsWith('.env.');
}
