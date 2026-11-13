import { cn } from "@/lib/utils";

export function passwordStrength(pw: string) {
  let s = 0;
  if (pw.length >= 12) s++;
  if (pw.length >= 16) s++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
  if (/\d/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  return Math.min(4, s);
}

export function StrengthMeter({ value }: { value: string }) {
  const s = passwordStrength(value);
  const label = ["Too short", "Weak", "Fair", "Strong", "Excellent"][s];
  return (
    <div className="grid gap-1.5" aria-live="polite">
      <div className="grid grid-cols-4 gap-1">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={cn("h-1 rounded-full bg-surface-3 transition-colors", i < s && (s <= 1 ? "bg-notmet" : s === 2 ? "bg-insufficient" : "bg-met"))} />
        ))}
      </div>
      <span className="text-xs text-muted">{value ? label : "12+ characters. A passphrase works well."}</span>
    </div>
  );
}
