import { useEffect, useState, type ReactNode } from 'react';
import type { Item } from '../api.ts';

function hue(s: string): number {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return h % 360;
}

/** Visual for an item: image, else emoji, else coloured initials. */
export function ItemFace({ item, size = 48 }: { item: Pick<Item, 'name' | 'emoji' | 'imageUrl'>; size?: number }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [item.imageUrl]);
  const style = { width: size, height: size, fontSize: size * 0.55 };
  if (item.imageUrl && !broken) {
    return <img className="face face-img" style={style} src={item.imageUrl} alt="" referrerPolicy="no-referrer" loading="lazy" onError={() => setBroken(true)} />;
  }
  if (item.emoji) {
    return (
      <span className="face face-emoji" style={style} aria-hidden>
        {item.emoji}
      </span>
    );
  }
  const initials = item.name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => [...w][0] ?? '')
    .join('')
    .toUpperCase();
  const h = hue(item.name);
  return (
    <span className="face face-initials" style={{ ...style, fontSize: size * 0.38, background: `linear-gradient(135deg, hsl(${h} 70% 45%), hsl(${(h + 50) % 360} 75% 35%))` }} aria-hidden>
      {initials}
    </span>
  );
}

export function ConfidenceBar({ value, label = true }: { value: number; label?: boolean }) {
  const pct = Math.round(value * 100);
  return (
    <div className="confidence" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Seguridad del rankeo">
      <div className="confidence-track">
        <div className="confidence-fill" style={{ width: `${pct}%` }} />
      </div>
      {label && <span className="confidence-label">{pct}% seguro</span>}
    </div>
  );
}

export function Spinner() {
  return <div className="spinner" aria-label="Cargando" />;
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-box" role="alert">
      <span>{message}</span>
      {onRetry && (
        <button className="btn btn-ghost btn-sm" onClick={onRetry}>
          Reintentar
        </button>
      )}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

let toastTimer: number | undefined;
/** Minimal global toast: one at a time, auto-hides. */
export function toast(message: string) {
  window.dispatchEvent(new CustomEvent('rg:toast', { detail: message }));
}

export function ToastHost() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    const on = (e: Event) => {
      setMsg((e as CustomEvent<string>).detail);
      window.clearTimeout(toastTimer);
      toastTimer = window.setTimeout(() => setMsg(null), 2800);
    };
    window.addEventListener('rg:toast', on);
    return () => window.removeEventListener('rg:toast', on);
  }, []);
  return (
    <div className="toast-host" aria-live="polite">
      {msg && <div className="toast">{msg}</div>}
    </div>
  );
}

/** Splits "🍕 Pizza" into emoji + name; plain lines have no emoji. */
export function parseItemLine(line: string): { name: string; emoji: string } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const m = trimmed.match(/^(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier})*)\s*(.+)$/u);
  return m ? { emoji: m[1]!, name: m[2]!.trim() } : { emoji: '', name: trimmed };
}

export function pluralize(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}
