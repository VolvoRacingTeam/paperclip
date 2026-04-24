/**
 * RedlineDiffView - Pakke C (SON-97 redline-diff-UI).
 *
 * Vises naar manager har redlinet en worker-payload. Renderer en
 * tre-kolonne layout: Original | Redlined | Diff. Diff-en er en simpel
 * JSON-key-basert sammenligning som markerer:
 *   - added (kun i redlined)
 *   - removed (kun i original)
 *   - changed (ulik verdi)
 *   - unchanged (skjult som default for kompakt visning)
 *
 * Kjenner igjen redline via:
 *   payload.__redlined_by_manager === true
 *     ELLER
 *   payload.__worker_review?.redlinedByManager === true
 *
 * Original payload hentes fra payload.__worker_review.originalWorkerOutput
 * (lagt til i promoteToApproval i samme pakke).
 */
import { useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";

type Json = Record<string, unknown>;

interface RedlineMeta {
  reviewId?: string;
  workerAgentId?: string;
  managerAgentId?: string;
  managerApprovedAt?: string;
  originalPayloadHash?: string;
  redlinedByManager?: boolean;
  originalWorkerOutput?: Json;
}

export function isRedlinedPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  if (p.__redlined_by_manager === true) return true;
  const meta = p.__worker_review;
  if (meta && typeof meta === "object" && (meta as Record<string, unknown>).redlinedByManager === true) {
    return true;
  }
  return false;
}

function readMeta(payload: Json): RedlineMeta | null {
  const meta = payload.__worker_review;
  if (meta && typeof meta === "object") {
    return meta as RedlineMeta;
  }
  return null;
}

/** Strip internal meta fields before display. */
function stripMeta(payload: Json): Json {
  const out: Json = {};
  for (const [k, v] of Object.entries(payload)) {
    if (k === "__worker_review") continue;
    if (k === "__redlined_by_manager") continue;
    out[k] = v;
  }
  return out;
}

type DiffKind = "added" | "removed" | "changed" | "unchanged";
interface DiffEntry { key: string; kind: DiffKind; original: unknown; redlined: unknown; }

function shallowDiff(original: Json, redlined: Json): DiffEntry[] {
  const keys = new Set<string>([...Object.keys(original), ...Object.keys(redlined)]);
  const entries: DiffEntry[] = [];
  for (const key of keys) {
    const inOrig = key in original;
    const inRed = key in redlined;
    if (inOrig && !inRed) {
      entries.push({ key, kind: "removed", original: original[key], redlined: undefined });
      continue;
    }
    if (!inOrig && inRed) {
      entries.push({ key, kind: "added", original: undefined, redlined: redlined[key] });
      continue;
    }
    const a = JSON.stringify(original[key]);
    const b = JSON.stringify(redlined[key]);
    entries.push({
      key,
      kind: a === b ? "unchanged" : "changed",
      original: original[key],
      redlined: redlined[key],
    });
  }
  // Sort changed/added/removed first for visibility.
  const order: Record<DiffKind, number> = { changed: 0, added: 1, removed: 2, unchanged: 3 };
  entries.sort((a, b) => order[a.kind] - order[b.kind] || a.key.localeCompare(b.key));
  return entries;
}

function fmt(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function ColumnPanel({ title, body }: { title: string; body: Json }) {
  return (
    <div className="border border-border rounded-md flex flex-col min-w-0">
      <div className="px-3 py-1.5 border-b border-border bg-muted/30 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      <pre className="text-xs p-3 overflow-auto whitespace-pre-wrap break-words max-h-96 font-mono">
        {fmt(body)}
      </pre>
    </div>
  );
}

function diffBadge(kind: DiffKind) {
  if (kind === "added") return <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-200">added</span>;
  if (kind === "removed") return <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-200">removed</span>;
  if (kind === "changed") return <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200">changed</span>;
  return <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-muted text-muted-foreground">same</span>;
}

export function RedlineBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-amber-300 dark:border-amber-700/40 bg-amber-50 dark:bg-amber-900/20 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:text-amber-200">
      <AlertTriangle className="h-3 w-3" />
      Manager har foreslaatt endringer
    </span>
  );
}

export function RedlineDiffView({ payload }: { payload: Record<string, unknown> }) {
  const [showUnchanged, setShowUnchanged] = useState(false);

  const meta = useMemo(() => readMeta(payload as Json), [payload]);
  const redlined = useMemo(() => stripMeta(payload as Json), [payload]);
  const original = useMemo<Json>(() => {
    const fromMeta = meta?.originalWorkerOutput;
    if (fromMeta && typeof fromMeta === "object") return fromMeta as Json;
    return {};
  }, [meta]);

  const diff = useMemo(() => shallowDiff(original, redlined), [original, redlined]);
  const visibleDiff = showUnchanged ? diff : diff.filter((d) => d.kind !== "unchanged");
  const hasOriginal = Object.keys(original).length > 0;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <RedlineBadge />
        {meta?.managerApprovedAt && (
          <span className="text-[11px] text-muted-foreground">
            Godkjent {new Date(meta.managerApprovedAt).toLocaleString()}
          </span>
        )}
      </div>

      {!hasOriginal && (
        <div className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
          Original worker-output er ikke tilgjengelig for denne approvalen
          (lagret foer Pakke C). Viser kun redlined-payload.
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-3 md:grid-cols-2 grid-cols-1">
        <ColumnPanel title="Original" body={original} />
        <ColumnPanel title="Redlined" body={redlined} />
        <div className="border border-border rounded-md flex flex-col min-w-0">
          <div className="px-3 py-1.5 border-b border-border bg-muted/30 text-xs font-medium uppercase tracking-wide text-muted-foreground flex items-center justify-between">
            <span>Diff</span>
            <button
              type="button"
              className="text-[10px] normal-case font-normal text-muted-foreground hover:text-foreground"
              onClick={() => setShowUnchanged((v) => !v)}
            >
              {showUnchanged ? "Skjul like" : "Vis alle"}
            </button>
          </div>
          <div className="text-xs p-3 overflow-auto max-h-96 space-y-2">
            {visibleDiff.length === 0 && (
              <p className="text-muted-foreground">Ingen forskjeller paa toppniva.</p>
            )}
            {visibleDiff.map((d) => (
              <div key={d.key} className="space-y-1">
                <div className="flex items-center gap-2">
                  {diffBadge(d.kind)}
                  <span className="font-mono text-xs">{d.key}</span>
                </div>
                {d.kind === "changed" && (
                  <div className="grid grid-cols-2 gap-2 text-[11px] font-mono">
                    <pre className="bg-red-50 dark:bg-red-900/20 rounded px-1.5 py-1 whitespace-pre-wrap break-words">
                      {fmt(d.original)}
                    </pre>
                    <pre className="bg-green-50 dark:bg-green-900/20 rounded px-1.5 py-1 whitespace-pre-wrap break-words">
                      {fmt(d.redlined)}
                    </pre>
                  </div>
                )}
                {d.kind === "added" && (
                  <pre className="text-[11px] font-mono bg-green-50 dark:bg-green-900/20 rounded px-1.5 py-1 whitespace-pre-wrap break-words">
                    {fmt(d.redlined)}
                  </pre>
                )}
                {d.kind === "removed" && (
                  <pre className="text-[11px] font-mono bg-red-50 dark:bg-red-900/20 rounded px-1.5 py-1 whitespace-pre-wrap break-words">
                    {fmt(d.original)}
                  </pre>
                )}
                {d.kind === "unchanged" && (
                  <pre className="text-[11px] font-mono text-muted-foreground bg-muted/40 rounded px-1.5 py-1 whitespace-pre-wrap break-words">
                    {fmt(d.original)}
                  </pre>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
