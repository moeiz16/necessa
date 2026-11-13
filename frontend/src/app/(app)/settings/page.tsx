"use client";

import { Laptop, LogOut, Monitor, Moon, ShieldCheck, ShieldOff, Smartphone, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { api, errorMessage } from "@/lib/api/client";
import { qk, useSessions, useUpdateMe } from "@/lib/api/hooks";
import { useSession } from "@/lib/api/session";
import { fmtRelative, ROLE_LABEL } from "@/lib/format";
import { AppPage } from "@/components/shell/app-shell";
import { SettingsNav } from "@/components/shell/settings-nav";
import { StrengthMeter } from "@/components/domain/password-strength";
import { Button } from "@/components/ui/button";
import { RadioCards, Switch, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/controls";
import { Avatar, Badge, Breadcrumb, Card, CardBody, CardHeader, PageHeader, Skeleton } from "@/components/ui/display";
import { Field, Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/overlays";

function MfaSetup({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient();
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open && !setup) api.post<{ secret: string; otpauthUrl: string }>("/auth/mfa/setup").then(setSetup).catch((e) => toast.error(errorMessage(e)));
  }, [open, setup]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={codes ? "Save your recovery codes" : "Set up two-step verification"} description={codes ? "Each code works once. Store them somewhere safe — they're shown only now." : "Scan the QR code with an authenticator app (1Password, Authy, Google Authenticator)."}>
        {codes ? (
          <div className="grid grid-cols-2 gap-2 rounded-lg bg-surface-2 p-4 font-mono text-sm">
            {codes.map((c) => (
              <span key={c}>{c}</span>
            ))}
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-[160px_1fr] sm:items-center">
            <div className="flex aspect-square items-center justify-center rounded-lg bg-white p-2">{setup ? <QRCodeSVG value={setup.otpauthUrl} size={140} /> : <Skeleton className="size-36" />}</div>
            <div className="grid gap-3">
              <Field label="Or enter this key manually">
                <code className="break-all rounded-md bg-surface-2 px-2 py-1.5 font-mono text-xs">{setup?.secret ?? "…"}</code>
              </Field>
              <Field label="6-digit code">
                <Input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" className="font-mono tracking-[0.3em]" />
              </Field>
            </div>
          </div>
        )}
        <DialogFooter>
          {codes ? (
            <Button variant="primary" onClick={() => onOpenChange(false)}>
              I&apos;ve saved them
            </Button>
          ) : (
            <Button
              variant="primary"
              loading={busy}
              disabled={code.length !== 6}
              onClick={async () => {
                setBusy(true);
                try {
                  const r = await api.post<{ recoveryCodes: string[] }>("/auth/mfa/verify", { code });
                  setCodes(r.recoveryCodes);
                  qc.invalidateQueries({ queryKey: qk.me });
                  toast.success("Two-step verification enabled");
                } catch (e) {
                  toast.error(errorMessage(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Verify & enable
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MfaDisable({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Disable two-step verification?" description="Enter a current code from your authenticator app to confirm. Practices that require two-step verification will block access until you re-enroll." size="sm">
        <Field label="6-digit code">
          <Input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" className="font-mono tracking-[0.3em]" autoFocus />
        </Field>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={busy}
            disabled={code.length !== 6}
            onClick={async () => {
              setBusy(true);
              try {
                await api.post("/auth/mfa/disable", { code });
                qc.invalidateQueries({ queryKey: qk.me });
                toast.success("Two-step verification disabled");
                onOpenChange(false);
              } catch (e) {
                toast.error(errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Disable
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function SettingsPage() {
  const { me } = useSession();
  const qc = useQueryClient();
  const update = useUpdateMe();
  const sessions = useSessions();
  const { theme, setTheme } = useTheme();
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [pw, setPw] = useState({ current: "", next: "" });
  const [mfaOpen, setMfaOpen] = useState(false);
  const [mfaOffOpen, setMfaOffOpen] = useState(false);
  const [notif, setNotif] = useState<Record<string, boolean>>({ sla: true, evaluation: true, denial: true, policy: true, digest: false });
  useEffect(() => {
    if (me) {
      setName(me.user.fullName);
      setTitle(me.user.title ?? "");
      if (me.user.preferences?.notifications) setNotif((n) => ({ ...n, ...me.user.preferences!.notifications }));
    }
  }, [me]);
  if (!me) return null;

  return (
    <AppPage crumbs={<Breadcrumb items={[{ label: "Settings" }, { label: "Personal" }]} />}>
      <PageHeader title="Settings" description="Your profile, security and preferences." />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[200px_minmax(0,1fr)]">
        <div className="min-w-0 overflow-x-auto scrollbar-thin lg:overflow-visible">
          <SettingsNav />
        </div>
        <Tabs defaultValue="profile">
          <TabsList className="mb-5">
            <TabsTrigger value="profile">Profile</TabsTrigger>
            <TabsTrigger value="security">Security</TabsTrigger>
            <TabsTrigger value="notifications">Notifications</TabsTrigger>
            <TabsTrigger value="appearance">Appearance</TabsTrigger>
          </TabsList>

          <TabsContent value="profile">
            <Card>
              <CardHeader title="Profile" description="Shown on case activity, letters and the compliance log." />
              <CardBody className="grid max-w-lg gap-4">
                <div className="flex items-center gap-3">
                  <Avatar name={me.user.fullName} color={me.user.avatarColor} size={48} />
                  <div className="grid">
                    <span className="text-[13px] font-medium">{me.user.email}</span>
                    {me.membership ? <Badge tone="brand" size="xs" className="w-fit">{ROLE_LABEL[me.membership.role]} · {me.activeOrg?.name}</Badge> : null}
                  </div>
                </div>
                <Field label="Full name">
                  <Input value={name} onChange={(e) => setName(e.target.value)} />
                </Field>
                <Field label="Title" hint="e.g. Prior Authorization Coordinator, MD">
                  <Input value={title} onChange={(e) => setTitle(e.target.value)} />
                </Field>
                <Button variant="primary" className="w-fit" loading={update.isPending} onClick={() => update.mutate({ fullName: name, title }, { onSuccess: () => toast.success("Profile saved") })}>
                  Save changes
                </Button>
              </CardBody>
            </Card>
          </TabsContent>

          <TabsContent value="security" className="grid gap-4">
            <Card>
              <CardHeader title="Two-step verification" description="Adds a second step at sign-in, so patient information stays protected even if your password is stolen." />
              <CardBody className="flex flex-wrap items-center justify-between gap-3">
                <span className="flex items-center gap-2 text-[13px]">
                  {me.user.mfaEnabled ? <ShieldCheck className="size-5 text-met" /> : <ShieldOff className="size-5 text-subtle" />}
                  {me.user.mfaEnabled ? "Enabled with an authenticator app" : "Not enabled"}
                </span>
                {me.user.mfaEnabled ? (
                  <Button variant="secondary" onClick={() => setMfaOffOpen(true)}>
                    Disable
                  </Button>
                ) : (
                  <Button variant="primary" onClick={() => setMfaOpen(true)}>
                    Enable two-step verification
                  </Button>
                )}
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Password" />
              <CardBody className="grid max-w-lg gap-4">
                <Field label="Current password">
                  <Input type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} autoComplete="current-password" />
                </Field>
                <Field label="New password">
                  <Input type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} autoComplete="new-password" />
                  <StrengthMeter value={pw.next} />
                </Field>
                <Button
                  variant="primary"
                  className="w-fit"
                  disabled={!pw.current || pw.next.length < 12}
                  onClick={async () => {
                    try {
                      await api.post("/users/me/password", { currentPassword: pw.current, newPassword: pw.next });
                      setPw({ current: "", next: "" });
                      toast.success("Password updated", { description: "Other sessions were signed out." });
                    } catch (e) {
                      toast.error(errorMessage(e));
                    }
                  }}
                >
                  Update password
                </Button>
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Active sessions" description="Revoke any session you don't recognize." />
              <CardBody className="grid gap-2">
                {(sessions.data ?? []).map((s) => (
                  <div key={s.id} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5">
                    {/iphone|android/i.test(s.userAgent) ? <Smartphone className="size-4 text-subtle" /> : <Laptop className="size-4 text-subtle" />}
                    <span className="grid min-w-0 flex-1">
                      <span className="text-[13px] font-medium">
                        {s.userAgent} {s.current ? <Badge tone="met" size="xs">this device</Badge> : null}
                      </span>
                      <span className="text-xs text-muted">
                        {s.ip} · last active {fmtRelative(s.lastUsedAt)}
                      </span>
                    </span>
                    {!s.current ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={async () => {
                          await api.del(`/auth/sessions/${s.id}`);
                          qc.invalidateQueries({ queryKey: qk.sessions });
                          toast.success("Session revoked");
                        }}
                      >
                        <LogOut /> Revoke
                      </Button>
                    ) : null}
                  </div>
                ))}
              </CardBody>
            </Card>
          </TabsContent>

          <TabsContent value="notifications">
            <Card>
              <CardHeader title="Notifications" description="In-app notifications are always on; choose what also reaches your email." />
              <CardBody className="grid gap-2">
                {[
                  { k: "sla", t: "SLA alerts", d: "Cases within 24 hours of the payer clock" },
                  { k: "evaluation", t: "Evaluation results", d: "When a medical-necessity check finishes on your cases" },
                  { k: "denial", t: "Denials", d: "New denials and approaching appeal deadlines" },
                  { k: "policy", t: "Policy changes", d: "LCD/NCD revisions affecting your open cases" },
                  { k: "digest", t: "Weekly digest", d: "Readiness trends and top gaps every Monday" },
                ].map((n) => (
                  <label key={n.k} className="flex items-center justify-between gap-4 rounded-lg border border-border px-3 py-2.5">
                    <span className="grid">
                      <span className="text-[13px] font-medium">{n.t}</span>
                      <span className="text-xs text-muted">{n.d}</span>
                    </span>
                    <Switch
                      checked={notif[n.k]}
                      onCheckedChange={(v) => {
                        const next = { ...notif, [n.k]: v };
                        setNotif(next);
                        update.mutate({ preferences: { ...me.user.preferences, notifications: next } });
                      }}
                    />
                  </label>
                ))}
              </CardBody>
            </Card>
          </TabsContent>

          <TabsContent value="appearance">
            <Card>
              <CardHeader title="Theme" />
              <CardBody>
                <RadioCards
                  columns={3}
                  value={theme ?? "system"}
                  onValueChange={(v) => {
                    setTheme(v);
                    update.mutate({ preferences: { ...me.user.preferences, theme: v as "light" | "dark" | "system" } });
                  }}
                  options={[
                    { value: "light", label: "Light", icon: <Sun /> },
                    { value: "dark", label: "Dark", icon: <Moon /> },
                    { value: "system", label: "System", icon: <Monitor /> },
                  ]}
                />
              </CardBody>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
      {mfaOpen ? <MfaSetup open={mfaOpen} onOpenChange={setMfaOpen} /> : null}
      {mfaOffOpen ? <MfaDisable open={mfaOffOpen} onOpenChange={setMfaOffOpen} /> : null}
    </AppPage>
  );
}
