import * as path from "node:path";

export const WORKSPACE_ROOT = path.resolve(process.cwd());

export const resolveWorkspacePath = (
  inputPath = ".",
): { ok: true; path: string } | { ok: false; error: string } => {
  const resolved = path.resolve(WORKSPACE_ROOT, inputPath);
  const relative = path.relative(WORKSPACE_ROOT, resolved);

  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return { ok: false, error: inputPath };
  }

  return { ok: true, path: resolved };
};
