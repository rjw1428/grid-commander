import { useEffect, useState } from "react";
import type { DirListing } from "@gridcommander/shared";
import { ApiClientError, api } from "../api/client.js";

/**
 * Inline directory browser backed by GET /api/fs/dirs (server filesystem, directories only).
 * `onPick` receives the absolute path of the folder the operator chose.
 */
export function DirPicker({ initial, onPick, onCancel }: { initial?: string; onPick: (path: string) => void; onCancel: () => void }) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [path, setPath] = useState<string | undefined>(initial || undefined);

  useEffect(() => {
    let alive = true;
    setBusy(true);
    api.fs
      .dirs(path, hidden)
      .then((l) => {
        if (!alive) return;
        setListing(l);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        if (e instanceof ApiClientError && path && (e.code === "outside_roots" || e.code === "not_found" || e.code === "not_a_directory")) {
          // fall back to the first root when the typed path is unusable
          setPath(undefined);
          return;
        }
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => alive && setBusy(false));
    return () => {
      alive = false;
    };
  }, [path, hidden]);

  if (error) {
    return (
      <div className="dirpicker">
        <p className="err">{error}</p>
        <button type="button" className="hbtn small" onClick={onCancel}>
          Close
        </button>
      </div>
    );
  }

  const crumbs = listing ? breadcrumbs(listing) : [];
  return (
    <div className="dirpicker" role="dialog" aria-label="choose a directory">
      <div className="dirpicker-head">
        <nav className="crumbs" aria-label="path">
          {crumbs.map((c, i) => (
            <span key={c.path}>
              {i > 0 && <span className="crumb-sep">/</span>}
              <button type="button" className="crumb" onClick={() => setPath(c.path)} disabled={c.path === listing?.path}>
                {c.label}
              </button>
            </span>
          ))}
        </nav>
        <label className="check hint">
          <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} /> hidden
        </label>
      </div>
      <div className={`dirlist${busy ? " busy" : ""}`}>
        {listing?.parent && (
          <button type="button" className="direntry up" onClick={() => setPath(listing.parent!)}>
            ↑ ..
          </button>
        )}
        {listing && listing.entries.length === 0 && <div className="empty">No sub-folders.</div>}
        {listing?.entries.map((e) => (
          <button key={e.path} type="button" className="direntry" onClick={() => setPath(e.path)} onDoubleClick={() => onPick(e.path)} title={e.path}>
            <span className="ico">{e.git ? "⎇" : "▸"}</span>
            <span className="dname">{e.name}</span>
            {e.git && <span className="chip idle">git</span>}
          </button>
        ))}
      </div>
      {listing && listing.roots.length > 1 && (
        <div className="roots">
          {listing.roots.map((r) => (
            <button key={r} type="button" className="hbtn small" onClick={() => setPath(r)} disabled={r === listing.path}>
              {r.split("/").filter(Boolean).pop() ?? r}
            </button>
          ))}
        </div>
      )}
      <div className="row-btns">
        <button type="button" className="btn" onClick={() => listing && onPick(listing.path)} disabled={!listing}>
          Use {listing?.name ? `“${listing.name}”` : "this folder"}
          {listing?.git ? " (git)" : ""}
        </button>
        <button type="button" className="hbtn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function breadcrumbs(l: DirListing): { label: string; path: string }[] {
  const root = l.roots.find((r) => l.path === r || l.path.startsWith(r.endsWith("/") ? r : r + "/"));
  if (!root) return [{ label: l.path, path: l.path }];
  const out = [{ label: root.split("/").filter(Boolean).pop() ?? root, path: root }];
  const rest = l.path.slice(root.length).split("/").filter(Boolean);
  let acc = root;
  for (const seg of rest) {
    acc = acc.endsWith("/") ? acc + seg : `${acc}/${seg}`;
    out.push({ label: seg, path: acc });
  }
  return out;
}
