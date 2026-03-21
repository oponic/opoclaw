import { resolve, join, relative } from "path";
import { existsSync } from "fs";

export const WORKSPACE_DIR = resolve(import.meta.dir, "../workspace");

function safePath(relativePath: string): string {
  const cleaned = relativePath.replace(/^\/+/, "");
  const abs = resolve(join(WORKSPACE_DIR, cleaned));

  const rel = relative(WORKSPACE_DIR, abs);
  if (rel.startsWith("..") || rel.includes("/../")) {
    throw new Error(`Access denied: "${relativePath}" escapes the workspace.`);
  }

  return abs;
}

export function readFile(relativePath: string): string {
  const abs = safePath(relativePath);
  if (!existsSync(abs)) {
    throw new Error(`File not found: ${relativePath}`);
  }
  return Bun.file(abs).text() as unknown as string;
}

export async function readFileAsync(relativePath: string): Promise<string> {
  const abs = safePath(relativePath);
  if (!existsSync(abs)) {
    throw new Error(`File not found: ${relativePath}`);
  }
  return Bun.file(abs).text();
}

export function getFilePath(relativePath: string): string {
  const abs = safePath(relativePath);
  if (!existsSync(abs)) {
    throw new Error(`File not found: ${relativePath}`);
  }
  return abs;
}

export async function editFile(relativePath: string, newContent: string): Promise<void> {
  const abs = safePath(relativePath);
  if (!existsSync(abs)) {
    throw new Error(
      `Cannot edit "${relativePath}": file does not exist. Creating new files is not allowed.`
    );
  }
  await Bun.write(abs, newContent);
}

export async function listFiles(): Promise<string[]> {
  const glob = new Bun.Glob("**/*");
  const files: string[] = [];
  for await (const file of glob.scan({ cwd: WORKSPACE_DIR, onlyFiles: true })) {
    // Normalize path separators to forward slashes for cross-platform consistency
    files.push(file.replace(/\\/g, '/'));
  }
  return files.sort();
}
