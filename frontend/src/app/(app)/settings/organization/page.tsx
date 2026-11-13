"use client";

import { Copy, KeyRound, Link2, MailPlus, Plug, ShieldCheck, Trash2, UserMinus } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useApiKeys, useCreateApiKey, useInvitations, useInvite, useMembers, useOrg, useRemoveMember, useRevokeApiKey, useRevokeInvite, useUpdateMember, useUpdateOrg } from "@/lib/api/hooks";
import { Can, useSession } from "@/lib/api/session";
import type { Org, Role } from "@/lib/api/types";
import { fmtDate, fmtRelative, ROLE_LABEL } from "@/lib/format";
import { PERMISSIONS } from "@/lib/permissions";
import { AppPage } from "@/components/shell/app-shell";
import { SettingsNav } from "@/components/shell/settings-nav";
import { Button } from "@/components/ui/button";
import { Checkbox, Select, Switch, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/controls";
import { Avatar, Badge, Breadcrumb, Card, CardBody, CardHeader, PageHeader, Skeleton } from "@/components/ui/display";
import { EmptyState } from "@/components/ui/empty";
import { Field, Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, Tooltip } from "@/components/ui/overlays";

const ROLES: Role[] = ["owner", "admin", "coordinator", "clinician", "reviewer", "rcm_manager", "auditor"];
const SCOPES = ["cases:read", "cases:write", "policies:read", "analytics:read"];

function copy(text: string) {
  navigator.clipboard?.writeText(text);
  toast.success("Copied to clipboard");
}

function ProfileTab({ org }: { org: Org }) {
  const update = useUpdateOrg();
  const [form, setForm] = useState({ name: org.name, npi: org.npi ?? "", specialty: org.specialty ?? "", timezone: org.timezone, states: org.states.join(", ") });
  return (
    <Card>
      <CardHeader title="Practice profile" description="Used on letters and for jurisdiction defaults." />
      <CardBody className="grid max-w-2xl gap-4 sm:grid-cols-2">
        <Field label="Practice name" className="sm:col-span-2">
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Group NPI">
          <Input value={form.npi} onChange={(e) => setForm({ ...form, npi: e.target.value.replace(/\D/g, "").slice(0, 10) })} className="font-mono" />
        </Field>
        <Field label="Specialty">
          <Input value={form.specialty} onChange={(e) => setForm({ ...form, specialty: e.target.value })} />
        </Field>
        <Field label="States served" hint="Comma-separated USPS codes" className="sm:col-span-2">
          <Input value={form.states} onChange={(e) => setForm({ ...form, states: e.target.value.toUpperCase() })} className="font-mono" />
        </Field>
        <Field label="Time zone">
          <Select
            value={form.timezone}
            onValueChange={(v) => setForm({ ...form, timezone: v })}
            options={["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles"].map((t) => ({ value: t, label: t.replace("America/", "").replace("_", " ") }))}
          />
        </Field>
        <div className="sm:col-span-2">
          <Button
            variant="primary"
            loading={update.isPending}
            onClick={() => update.mutate({ name: form.name, npi: form.npi || null, specialty: form.specialty, timezone: form.timezone, states: form.states.split(/[\s,]+/).filter(Boolean) })}
          >
            Save profile
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

function MembersTab() {
  const { me } = useSession();
  const members = useMembers();
  const updateM = useUpdateMember();
  const remove = useRemoveMember();
  const invites = useInvitations();
  const invite = useInvite();
  const revoke = useRevokeInvite();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("coordinator");
  const [devLink, setDevLink] = useState<string | null>(null);
  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader title="Invite a teammate" description="Invitations expire after 7 days." />
        <CardBody>
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              invite.mutate(
                { email, role },
                {
                  onSuccess: (r) => {
                    setEmail("");
                    setDevLink(r.devLink ?? null);
                    toast.success(`Invitation sent to ${r.invitation.email}`);
                  },
                },
              );
            }}
          >
            <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="colleague@practice.com" className="max-w-xs" leading={<MailPlus />} />
            <Select className="w-48" value={role} onValueChange={(v) => setRole(v as Role)} options={ROLES.filter((r) => r !== "owner").map((r) => ({ value: r, label: ROLE_LABEL[r] }))} aria-label="Role" />
            <Button type="submit" variant="primary" loading={invite.isPending}>
              Send invite
            </Button>
          </form>
          {devLink ? (
            <p className="mt-3 flex items-center gap-2 text-xs text-muted">
              <Link2 className="size-3.5" /> Email delivery is simulated in development —
              <button className="text-brand hover:underline" onClick={() => copy(`${location.origin}${devLink}`)}>
                copy invite link
              </button>
            </p>
          ) : null}
        </CardBody>
      </Card>
      <Card className="overflow-hidden">
        <CardHeader title={`Members · ${members.data?.length ?? 0}`} />
        <CardBody className="px-0">
          {members.isPending ? (
            <Skeleton className="mx-4 h-40" />
          ) : (
            <table className="w-full text-[13px]">
              <thead className="text-xs text-muted">
                <tr>
                  {["Member", "Role", "MFA", "Last active", ""].map((h) => (
                    <th key={h} className="px-4 py-2 text-left font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(members.data ?? []).map((m) => (
                  <tr key={m.id} className="border-t border-border/70">
                    <td className="px-4 py-2.5">
                      <span className="flex items-center gap-2.5">
                        <Avatar name={m.fullName} color={m.avatarColor} size={28} />
                        <span className="grid leading-tight">
                          <span className="font-medium">
                            {m.fullName} {m.id === me?.user.id ? <span className="text-xs text-subtle">(you)</span> : null}
                          </span>
                          <span className="text-xs text-muted">{m.email}</span>
                        </span>
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      <Select size="sm" className="w-44" value={m.role} disabled={m.id === me?.user.id} onValueChange={(v) => updateM.mutate({ userId: m.id, role: v })} aria-label={`Role for ${m.fullName}`} options={ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))} />
                    </td>
                    <td className="px-4 py-2.5">{m.mfaEnabled ? <Badge tone="met" size="xs"><ShieldCheck /> On</Badge> : <Badge size="xs">Off</Badge>}</td>
                    <td className="px-4 py-2.5 text-xs text-muted">{fmtRelative(m.lastLoginAt)}</td>
                    <td className="px-4 py-2.5 text-right">
                      {m.id !== me?.user.id ? (
                        <Tooltip content="Remove from organization">
                          <Button variant="ghost" size="icon-sm" aria-label={`Remove ${m.fullName}`} onClick={() => remove.mutate(m.id)}>
                            <UserMinus />
                          </Button>
                        </Tooltip>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Pending invitations" />
        <CardBody className="grid gap-2">
          {(invites.data ?? []).length === 0 ? <p className="text-[13px] text-muted">No pending invitations.</p> : null}
          {(invites.data ?? []).map((i) => (
            <div key={i.id} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2">
              <MailPlus className="size-4 text-subtle" />
              <span className="min-w-0 flex-1 text-[13px]">
                {i.email} <Badge size="xs">{ROLE_LABEL[i.role]}</Badge>
              </span>
              <span className="text-xs text-subtle">expires {fmtDate(i.expiresAt)}</span>
              <Button variant="ghost" size="xs" onClick={() => revoke.mutate(i.id)}>
                Revoke
              </Button>
            </div>
          ))}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Role permissions" description="Enforced server-side on every request and by row-level security in the database." />
        <CardBody className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr>
                <th className="py-1.5 pr-3 text-left font-medium text-muted">Permission</th>
                {ROLES.map((r) => (
                  <th key={r} className="px-2 py-1.5 text-center font-medium text-muted">
                    {ROLE_LABEL[r]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Object.entries(PERMISSIONS).map(([perm, roles]) => (
                <tr key={perm} className="border-t border-border/60">
                  <td className="py-1.5 pr-3 font-mono text-[11px]">{perm}</td>
                  {ROLES.map((r) => (
                    <td key={r} className="px-2 py-1.5 text-center">
                      {roles.includes(r) ? <span className="text-met">●</span> : <span className="text-border-strong">·</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </CardBody>
      </Card>
    </div>
  );
}

function ApiKeysTab() {
  const keys = useApiKeys();
  const create = useCreateApiKey();
  const revoke = useRevokeApiKey();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["cases:read"]);
  const [secret, setSecret] = useState<string | null>(null);
  return (
    <Card>
      <CardHeader
        title="API keys"
        description="For EHR or RCM integrations. Keys are hashed at rest and shown once."
        actions={
          <Button size="sm" variant="primary" onClick={() => (setOpen(true), setSecret(null), setName(""))}>
            <KeyRound /> Create key
          </Button>
        }
      />
      <CardBody className="grid gap-2">
        {(keys.data ?? []).length === 0 ? <EmptyState compact art="shield" title="No API keys" /> : null}
        {(keys.data ?? []).map((k) => (
          <div key={k.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-border px-3 py-2.5">
            <KeyRound className="size-4 text-subtle" />
            <span className="grid min-w-0 flex-1">
              <span className="text-[13px] font-medium">{k.name}</span>
              <span className="font-mono text-xs text-muted">{k.prefix}••••••••••••</span>
            </span>
            <span className="flex flex-wrap gap-1">
              {k.scopes.map((s) => (
                <Badge key={s} size="xs" className="font-mono">
                  {s}
                </Badge>
              ))}
            </span>
            <span className="text-xs text-subtle">{k.lastUsedAt ? `used ${fmtRelative(k.lastUsedAt)}` : "never used"}</span>
            <Button variant="ghost" size="icon-sm" aria-label="Revoke key" onClick={() => revoke.mutate(k.id)}>
              <Trash2 />
            </Button>
          </div>
        ))}
      </CardBody>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title={secret ? "Copy your API key" : "Create API key"} description={secret ? "This is the only time the full key is shown." : "Grant the minimum scopes the integration needs."}>
          {secret ? (
            <div className="flex items-center gap-2 rounded-lg bg-surface-2 p-3">
              <code className="min-w-0 flex-1 break-all font-mono text-xs">{secret}</code>
              <Button size="icon-sm" variant="ghost" aria-label="Copy key" onClick={() => copy(secret)}>
                <Copy />
              </Button>
            </div>
          ) : (
            <div className="grid gap-4">
              <Field label="Name">
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Epic integration (prod)" autoFocus />
              </Field>
              <Field label="Scopes">
                <div className="grid gap-2">
                  {SCOPES.map((s) => (
                    <label key={s} className="flex items-center gap-2 font-mono text-xs">
                      <Checkbox checked={scopes.includes(s)} onCheckedChange={(v) => setScopes(v ? [...scopes, s] : scopes.filter((x) => x !== s))} />
                      {s}
                    </label>
                  ))}
                </div>
              </Field>
            </div>
          )}
          <DialogFooter>
            {secret ? (
              <Button variant="primary" onClick={() => setOpen(false)}>
                Done
              </Button>
            ) : (
              <Button variant="primary" loading={create.isPending} disabled={!name || !scopes.length} onClick={() => create.mutate({ name, scopes }, { onSuccess: (r) => setSecret(r.secret) })}>
                Create key
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function PoliciesTab({ org }: { org: Org }) {
  const update = useUpdateOrg();
  const [s, setS] = useState(org.settings);
  useEffect(() => setS(org.settings), [org.settings]);
  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader title="Service levels" description="Drive case due dates and SLA alerts. Defaults mirror CMS-0057-F payer decision timeframes." />
        <CardBody className="grid max-w-2xl gap-4 sm:grid-cols-2">
          <Field label="Standard (hours)">
            <Input type="number" value={s.slaHoursStandard} onChange={(e) => setS({ ...s, slaHoursStandard: Number(e.target.value) })} />
          </Field>
          <Field label="Expedited (hours)">
            <Input type="number" value={s.slaHoursExpedited} onChange={(e) => setS({ ...s, slaHoursExpedited: Number(e.target.value) })} />
          </Field>
          <Field label="Default policy as-of date" className="sm:col-span-2">
            <Select
              value={s.defaultAsOf}
              onValueChange={(v) => setS({ ...s, defaultAsOf: v as "dos" | "today" })}
              options={[
                { value: "dos", label: "Date of service (recommended)" },
                { value: "today", label: "Today" },
              ]}
            />
          </Field>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Security & retention" />
        <CardBody className="grid max-w-2xl gap-3">
          <label className="flex items-center justify-between gap-4 rounded-lg border border-border px-3 py-2.5">
            <span className="grid">
              <span className="text-[13px] font-medium">Require two-step verification</span>
              <span className="text-xs text-muted">Members without MFA are blocked from case data until they enroll.</span>
            </span>
            <Switch checked={s.requireMfa} onCheckedChange={(v) => setS({ ...s, requireMfa: v })} />
          </label>
          <Field label="Case data retention after closure">
            <Select
              value={String(s.dataRetentionDays)}
              onValueChange={(v) => setS({ ...s, dataRetentionDays: Number(v) })}
              options={[
                { value: "90", label: "90 days" },
                { value: "365", label: "1 year" },
                { value: "2190", label: "6 years (HIPAA documentation)" },
              ]}
            />
          </Field>
          <Button variant="primary" className="w-fit" loading={update.isPending} onClick={() => update.mutate({ settings: s })}>
            Save settings
          </Button>
        </CardBody>
      </Card>
    </div>
  );
}

function IntegrationsTab() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {[
        { t: "FHIR R4 endpoint", d: "Pull Patient, Condition, Procedure and DocumentReference resources directly from your EHR (SMART on FHIR).", s: "Planned" },
        { t: "Da Vinci PAS export", d: "Submit prior-auth bundles to payers that expose a CMS-0057-F Prior Authorization API.", s: "Planned" },
        { t: "Webhooks", d: "case.evaluated, letter.approved and denial.recorded events, HMAC-signed.", s: "Available via API" },
        { t: "CMS Medicare Coverage Database", d: "Weekly MCD export ingestion (AMA/ADA/AHA license accepted by an admin).", s: "Connected" },
      ].map((x) => (
        <Card key={x.t}>
          <CardBody className="grid gap-2 pt-4">
            <div className="flex items-center gap-2">
              <Plug className="size-4 text-subtle" />
              <span className="text-[13px] font-semibold">{x.t}</span>
              <Badge tone={x.s === "Connected" ? "met" : x.s === "Planned" ? "neutral" : "brand"} size="xs" className="ml-auto">
                {x.s}
              </Badge>
            </div>
            <p className="text-[13px] text-muted">{x.d}</p>
          </CardBody>
        </Card>
      ))}
    </div>
  );
}

export default function OrganizationSettingsPage() {
  const org = useOrg();
  return (
    <AppPage crumbs={<Breadcrumb items={[{ label: "Settings", href: "/settings" }, { label: "Organization" }]} />}>
      <PageHeader title="Organization" description="Practice profile, team, access and integrations." />
      <div className="grid gap-6 lg:grid-cols-[200px_minmax(0,1fr)]">
        <SettingsNav />
        <Can perm="org:admin" fallback={<EmptyState art="shield" title="Admins only" description="Ask an owner or admin to change organization settings." />}>
          {org.data ? (
            <Tabs defaultValue="members">
              <TabsList className="mb-5">
                <TabsTrigger value="members">Members</TabsTrigger>
                <TabsTrigger value="profile">Profile</TabsTrigger>
                <TabsTrigger value="keys">API keys</TabsTrigger>
                <TabsTrigger value="policies">SLAs & security</TabsTrigger>
                <TabsTrigger value="integrations">Integrations</TabsTrigger>
              </TabsList>
              <TabsContent value="members">
                <MembersTab />
              </TabsContent>
              <TabsContent value="profile">
                <ProfileTab org={org.data} />
              </TabsContent>
              <TabsContent value="keys">
                <ApiKeysTab />
              </TabsContent>
              <TabsContent value="policies">
                <PoliciesTab org={org.data} />
              </TabsContent>
              <TabsContent value="integrations">
                <IntegrationsTab />
              </TabsContent>
            </Tabs>
          ) : (
            <Skeleton className="h-96 rounded-xl" />
          )}
        </Can>
      </div>
    </AppPage>
  );
}
