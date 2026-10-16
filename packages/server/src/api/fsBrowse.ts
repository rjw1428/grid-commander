import { readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { DirListing } from "@gridcommander/shared";
import { ApiError, badRequest } from "../errors.js";

const dirNotFound = () => new ApiError(404, "not_found", "directory not found");

/**
 * Server-side directory browser for the project "working directory" picker.
 * Lists directories only (no files, no contents), confined to `roots` by the path as
 * navigated: `..` is normalised away and the result must sit under a root. Symlinked
 * directories inside a root are browsable (operators commonly link their repos folder
 * to another volume); the returned paths are the logical ones. No shell is involved.
 */
export function listDirs(roots: string[], requested: string | undefined, showHidden = false): DirListing {
  const realRoots = roots.map((r) => resolve(r)).filter((r) => isDir(r));
  if (!realRoots.length) throw new ApiError(404, "no_roots", "no browsable roots configured");
  const target = requested ? resolve(requested) : realRoots[0]!;
  if (!realRoots.some((r) => inside(target, r))) throw badRequest("path is outside the browsable roots", "outside_roots");
  let st;
  try {
    st = statSync(target);
  } catch {
    throw dirNotFound();
  }
  if (!st.isDirectory()) throw badRequest("path is not a directory", "not_a_directory");

  const entries: DirListing["entries"] = [];
  for (const d of readdirSync(target, { withFileTypes: true })) {
    if (!showHidden && d.name.startsWith(".")) continue;
    const full = join(target, d.name);
    if (!(d.isDirectory() || (d.isSymbolicLink() && isDir(full)))) continue;
    entries.push({ name: d.name, path: full, git: isGitRepo(full) });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const parentCandidate = dirname(target);
  const parent = parentCandidate !== target && realRoots.some((r) => inside(parentCandidate, r)) ? parentCandidate : null;
  return { path: target, name: basename(target) || target, parent, roots: realRoots, git: isGitRepo(target), entries };
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function inside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

function isGitRepo(dir: string): boolean {
  try {
    return statSync(join(dir, ".git")).isDirectory();
  } catch {
    return false;
  }
}
