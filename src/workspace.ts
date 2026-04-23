import { dirname, join, relative, resolve, sep } from "path";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "fs";

export const WORKSPACE_DIR = resolve(import.meta.dir, "../workspace");

function normalizeRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
}

function assertWithinRoot(root: string, target: string, relativePath: string): void {
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || rel.includes(`${sep}..${sep}`) || rel === "") {
    if (rel === "") {
      return;
    }
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

export async function readFile(relativePath: string, mounts?: Record<string, string>): Promise<string> {
  const abs = safePath(relativePath, mounts);
  if (!existsSync(abs)) {
    throw new Error(`File not found: ${relativePath}`);
  }
  return await Bun.file(abs).text();
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
  mkdirSync(dirname(abs), { recursive: true });
  await Bun.write(abs, newContent);
}

export function mkdirPath(relativePath: string, mounts?: Record<string, string>): string {
  const { abs } = resolveMountPath(relativePath, mounts);
  if (existsSync(abs) && statSync(abs).isDirectory()) return `Directory already exists: ${relativePath}`;
  mkdirSync(abs, { recursive: true });
  return `Created directory: ${relativePath}`;
}

export function removePath(relativePath: string, recursive = false, mounts?: Record<string, string>): string {
  const { abs } = resolveMountPath(relativePath, mounts);
  if (!existsSync(abs)) throw new Error(`Path not found: ${relativePath}`);
  const st = statSync(abs);
  if (st.isDirectory() && !recursive) throw new Error("Path is a directory; set recursive=true to remove directories.");
  rmSync(abs, { recursive, force: true });
  return `Removed: ${relativePath}`;
}

export function movePath(srcRelative: string, destRelative: string, mounts?: Record<string, string>): string {
  const { abs: src } = resolveMountPath(srcRelative, mounts);
  const { abs: dest } = resolveMountPath(destRelative, mounts);
  if (!existsSync(src)) throw new Error(`Source not found: ${srcRelative}`);
  const parent = dirname(dest);
  mkdirSync(parent, { recursive: true });
  renameSync(src, dest);
  return `Moved ${srcRelative} -> ${destRelative}`;
}

function copyDirRecursive(s: string, d: string) {
  mkdirSync(d, { recursive: true });
  for (const name of readdirSync(s)) {
    const sp = resolve(s, name);
    const dp = resolve(d, name);
    const si = statSync(sp);
    if (si.isDirectory()) copyDirRecursive(sp, dp);
    else copyFileSync(sp, dp);
  }
}

export function copyPath(srcRelative: string, destRelative: string, recursive = false, mounts?: Record<string, string>): string {
  const { abs: src } = resolveMountPath(srcRelative, mounts);
  const { abs: dest } = resolveMountPath(destRelative, mounts);
  if (!existsSync(src)) throw new Error(`Source not found: ${srcRelative}`);
  const st = statSync(src);
  const destParent = dirname(dest);
  mkdirSync(destParent, { recursive: true });
  if (st.isDirectory()) {
    if (!recursive) throw new Error("Source is a directory; set recursive=true to copy directories.");
    copyDirRecursive(src, dest);
  } else {
    copyFileSync(src, dest);
  }
  return `Copied ${srcRelative} -> ${destRelative}`;
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

export const readFileAsync = readFile;
