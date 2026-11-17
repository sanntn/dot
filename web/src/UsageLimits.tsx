import type { ClaudeUsage, UsageLimit, UsageSpend } from "@dot/shared";
import { Gauge, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api, errorMessage } from "./api.ts";

// The subscription limits of the account a project runs on, in a popover off the header.
// The server caches for a minute, so opening it often does not hit Anthropic each time.

const REFRESH_MS = 5 * 60_000;

type Severity = UsageLimit["severity"];

const barColor: Record<Severity, string> = {
  normal: "bg-primary",
  warning: "bg-amber-500",
  critical: "bg-destructive",
};
const textColor: Record<Severity, string> = {
  normal: "text-muted-foreground",
  warning: "text-amber-700 dark:text-amber-400",
  critical: "text-destructive",
};

function formatReset(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return null;
  const minutes = Math.max(0, Math.round((at - now) / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const left = days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
  const when = new Intl.DateTimeFormat(undefined, {
    weekday: days > 0 ? "short" : undefined,
    hour: "numeric",
    minute: "2-digit",
  }).format(at);
  return `Resets in ${left}, ${when}`;
}

function money(minor: number, spend: UsageSpend): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: spend.currency }).format(minor / 10 ** spend.exponent);
  } catch {
    return `${(minor / 10 ** spend.exponent).toFixed(spend.exponent)} ${spend.currency}`;
  }
}

function Meter({ label, percent, severity, value, detail }: { label: string; percent: number; severity: Severity; value: string; detail: string | null }) {
  const clamped = Math.min(100, Math.max(0, percent));
  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium">{label}</span>
        <span className={`tabular-nums ${textColor[severity]}`}>{value}</span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(clamped)}
        aria-valuetext={value}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div className={`h-full rounded-full ${barColor[severity]}`} style={{ width: `${clamped}%`, minWidth: clamped > 0 ? 4 : 0 }} />
      </div>
      {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-3">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h3>
      {children}
    </section>
  );
}

function Body({ usage, now }: { usage: ClaudeUsage; now: number }) {
  const session = usage.limits.filter((l) => l.group === "session");
  const weekly = usage.limits.filter((l) => l.group === "weekly");
  const { spend } = usage;
  if (usage.limits.length === 0 && !spend) {
    return <p className="text-sm text-muted-foreground">This account reports no limits.</p>;
  }
  return (
    <div className="grid gap-5">
      {session.length > 0 && (
        <Section title="Session">
          {session.map((l) => (
            <Meter key={l.id} label={l.label} percent={l.percent} severity={l.severity} value={`${Math.round(l.percent)}% used`} detail={formatReset(l.resetsAt, now)} />
          ))}
        </Section>
      )}
      {weekly.length > 0 && (
        <Section title="Weekly">
          {weekly.map((l) => (
            <Meter key={l.id} label={l.label} percent={l.percent} severity={l.severity} value={`${Math.round(l.percent)}% used`} detail={formatReset(l.resetsAt, now)} />
          ))}
        </Section>
      )}
      {spend && (
        <Section title="Extra usage">
          <Meter
            label="Credits after plan limits"
            percent={spend.percent}
            severity={spend.severity}
            value={spend.limitMinor !== null ? `${money(spend.usedMinor, spend)} of ${money(spend.limitMinor, spend)}` : money(spend.usedMinor, spend)}
            detail={null}
          />
        </Section>
      )}
    </div>
  );
}

// The tightest limit decides the trigger's colour and number, so a glance says whether to worry.
function tightest(usage: ClaudeUsage | null): { percent: number; severity: Severity } | null {
  const items = [...(usage?.limits ?? [])];
  if (items.length === 0) return null;
  const top = items.reduce((a, b) => (b.percent > a.percent ? b : a));
  return { percent: top.percent, severity: top.severity };
}

export function UsageLimits({ configDir, token }: { configDir: string | null; token: string | null }) {
  const [usage, setUsage] = useState<ClaudeUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // Ignore an answer for an account the user has already switched away from.
  const account = `${token ?? ""}|${configDir ?? ""}`;
  const current = useRef(account);
  current.current = account;

  const load = useCallback(async () => {
    const asked = account;
    setLoading(true);
    try {
      const next = await api.claudeUsage(configDir, token);
      if (current.current !== asked) return;
      setUsage(next);
      setError(null);
      setNow(Date.now());
    } catch (err) {
      if (current.current === asked) setError(errorMessage(err));
    } finally {
      if (current.current === asked) setLoading(false);
    }
  }, [account, configDir, token]);

  useEffect(() => {
    setUsage(null);
    setError(null);
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const top = tightest(usage);
  const label = top ? `Claude limits, ${Math.round(top.percent)}% used` : "Claude limits";

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void load();
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="ghost" aria-label={label} title={label}>
          <Gauge aria-hidden="true" className={top && top.severity !== "normal" ? textColor[top.severity] : undefined} />
          {top ? <span className={`tabular-nums ${top.severity !== "normal" ? textColor[top.severity] : ""}`}>{Math.round(top.percent)}%</span> : "Limits"}
        </Button>
      </PopoverTrigger>
      <PopoverContent>
        <div className="mb-4 flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">Claude limits</h2>
          <Button variant="ghost" size="icon-xs" aria-label="Refresh limits" disabled={loading} onClick={() => void load()}>
            <RefreshCw aria-hidden="true" className={loading ? "animate-spin" : undefined} />
          </Button>
        </div>
        {usage && <Body usage={usage} now={now} />}
        {error && <p role="alert" className={`text-sm text-destructive ${usage ? "mt-4" : ""}`}>{error}</p>}
        {!usage && !error && <p className="text-sm text-muted-foreground">Loading limits</p>}
        {usage && (
          <p className="mt-4 text-xs text-muted-foreground">
            Updated {new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(usage.fetchedAt))}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
