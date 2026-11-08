/** Search keys are lexical, never a claim that two symlinks identify one file. */
function windowsPath(path: string, sessionId: string | null): boolean {
  return !sessionId && (/^[a-z]:[/\\]/i.test(path) || /^\\\\/.test(path) || /^\/\/[^/]/.test(path));
}

export function searchPathKey(path: string, sessionId: string | null): string {
  const normalized = windowsPath(path, sessionId) ? path.replace(/\\/g, "/").toLowerCase() : path;
  return normalized.replace(/\/+$/, "");
}

export function searchParent(path: string, sessionId: string | null): string {
  const index = windowsPath(path, sessionId)
    ? Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
    : path.lastIndexOf("/");
  // Retain the separator on drive roots; C: alone is drive-relative on Windows.
  if (index === 2 && /^[a-z]:/i.test(path)) return path.slice(0, 3);
  return index > 0 ? path.slice(0, index) : "/";
}

export function inSearchRoot(file: string, root: string, sessionId: string | null): boolean {
  const candidate = searchPathKey(file, sessionId);
  const directory = searchPathKey(root, sessionId);
  return candidate === directory || candidate.startsWith(`${directory}/`);
}
