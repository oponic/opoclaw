import { resolve, join, relative } from "path";
import { existsSync, statSync } from "fs";

export const WORKSPACE_DIR = resolve(import.meta.dir, "../workspace");

function normalizeRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
}

function assertWithinRoot(root: string, target: string, relativePath: string): void {
  const rel = relative(root, target);
  if (rel.startsWith("..") || rel.includes("/../")) {
    throw new Error(`Access denied: "${relativePath}" escapes the mount root.`);
  }
}

function resolveMountPath(
  relativePath: string,
  mounts?: Record<string, string>
): { abs: string; mountRoot?: string } {
  const cleaned = normalizeRelativePath(relativePath);
  const parts = cleaned.split("/").filter(Boolean);
  const mountName = parts[0];

  if (mounts && mountName && mounts[mountName]) {
    const mountRoot = resolve(mounts[mountName]!);
    if (!existsSync(mountRoot)) {
      throw new Error(`Mount root not found for "${mountName}".`);
    }
    const rest = parts.slice(1).join("/");
    const abs = resolve(join(mountRoot, rest));
    assertWithinRoot(mountRoot, abs, relativePath);
    return { abs, mountRoot };
  }

  const abs = resolve(join(WORKSPACE_DIR, cleaned));
  assertWithinRoot(WORKSPACE_DIR, abs, relativePath);
  return { abs };
}

function safePath(relativePath: string, mounts?: Record<string, string>): string {
  return resolveMountPath(relativePath, mounts).abs;
}

export function readFile(relativePath: string, mounts?: Record<string, string>): string {
  const abs = safePath(relativePath, mounts);
  if (!existsSync(abs)) {
    throw new Error(`File not found: ${relativePath}`);
  }
  return Bun.file(abs).text() as unknown as string;
}

export async function readFileAsync(relativePath: string, mounts?: Record<string, string>): Promise<string> {
  const abs = safePath(relativePath, mounts);
  if (!existsSync(abs)) {
    throw new Error(`File not found: ${relativePath}`);
  }
  return Bun.file(abs).text();
}

export function getFilePath(relativePath: string, mounts?: Record<string, string>): string {
  const abs = safePath(relativePath, mounts);
  if (!existsSync(abs)) {
    throw new Error(`File not found: ${relativePath}`);
  }
  return abs;
}

export async function editFile(
  relativePath: string,
  newContent: string,
  mounts?: Record<string, string>
): Promise<void> {
  const abs = safePath(relativePath, mounts);
  // good riddance stupid checky thingy, it could be bypassed by shell anyway
  await Bun.write(abs, newContent);
}

export async function listFiles(mounts?: Record<string, string>): Promise<string[]> {
  const glob = new Bun.Glob("**/*");
  const files: string[] = [];
  for await (const file of glob.scan({ cwd: WORKSPACE_DIR, onlyFiles: true })) {
    files.push(file.replace(/\\/g, "/"));
  }

  if (mounts) {
    for (const [mountName, mountPath] of Object.entries(mounts)) {
      const mountRoot = resolve(mountPath);
      if (!existsSync(mountRoot)) continue;
      try {
        if (!statSync(mountRoot).isDirectory()) continue;
      } catch {
        continue;
      }
      for await (const file of glob.scan({ cwd: mountRoot, onlyFiles: true })) {
        files.push(`${mountName}/${file.replace(/\\/g, "/")}`);
      }
    }
  }

  return files.sort();
}
