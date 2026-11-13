import type { AuditEntry } from "@/lib/api/types";

/** Plain-language names for recorded activity. Covers the live service's action names and the sample workspace's. */
const ACTIONS: Record<string, string> = {
  "auth.login": "Signed in",
  "auth.login_failed": "Failed sign-in attempt",
  "auth.logout": "Signed out",
  "auth.signup": "Created an account",
  "auth.switch_org": "Switched practice",
  "auth.password_reset": "Reset a password",
  "auth.password_reset_requested": "Requested a password reset",
  "auth.session_revoked": "Ended a signed-in session",
  "auth.refresh_reuse_detected": "Ended a session after unusual activity",
  "auth.mfa_enabled": "Turned on two-step verification",
  "auth.mfa_disabled": "Turned off two-step verification",
  "auth.mfa.enable": "Turned on two-step verification",
  "auth.mfa.disable": "Turned off two-step verification",
  "auth.mfa_setup_started": "Started two-step verification setup",
  "auth.mfa_failed": "Failed two-step verification",
  "user.password_changed": "Changed their password",
  "user.profile_updated": "Updated their profile",
  "phi.patient_revealed": "Viewed patient details",
  "phi.document_revealed": "Viewed an unmasked document",
  "patient.reveal_phi": "Viewed patient details",
  "document.reveal_phi": "Viewed an unmasked document",
  "case.created": "Created a case",
  "case.create": "Created a case",
  "case.updated": "Updated a case",
  "case.closed": "Closed a case",
  "case.close": "Closed a case",
  "case.document_added": "Added a document to a case",
  "case.document_uploaded": "Uploaded a document",
  "case.document_deleted": "Removed a document",
  "document.upload": "Uploaded a document",
  "case.evaluate": "Checked a case against policy",
  "case.evaluation.completed": "Finished checking a case",
  "case.review.complete": "Completed a case review",
  "case.criterion.override": "Changed a suggested result",
  "case.outcome_recorded": "Recorded a payer outcome",
  "case.outcome": "Recorded a payer outcome",
  "denial.record": "Recorded a denial",
  "letter.approve": "Approved a letter",
  "guardrail.injection.quarantine": "Held back a suspicious document",
  "org.created": "Created the practice",
  "org.updated": "Updated practice settings",
  "org.update": "Updated practice settings",
  "org.onboarding_completed": "Finished setup",
  "org.invitation_created": "Invited a team member",
  "org.member.invite": "Invited a team member",
  "org.invitation_accepted": "Accepted an invitation",
  "org.invitation_revoked": "Cancelled an invitation",
  "org.member_updated": "Changed a team member's access",
  "org.member.update": "Changed a team member's access",
  "org.member_removed": "Removed a team member",
  "org.member.remove": "Removed a team member",
  "org.api_key_created": "Created an access key",
  "org.api_key.create": "Created an access key",
  "org.api_key_revoked": "Revoked an access key",
  "org.api_key.revoke": "Revoked an access key",
  "org.demo_data.seed": "Loaded sample data",
  "org.demo_data.load": "Loaded sample data",
  "audit.chain_verified": "Checked the activity log",
  "audit.verify": "Checked the activity log",
  "analytics.ask": "Asked a question about cases",
  "assistant.message": "Asked Necessa a question",
  "assistant.conversation_deleted": "Deleted a conversation",
  "feedback.submitted": "Sent feedback",
  "criteria.update": "Edited a requirements checklist",
  "criteria.compile": "Prepared a requirements checklist",
  "knowledge.ingestion_started": "Refreshed the policy library",
  "knowledge.ingest.start": "Refreshed the policy library",
  "knowledge.download_started": "Started a policy download",
  "knowledge.index_activated": "Switched policy library version",
  "knowledge.index.activate": "Switched policy library version",
  "knowledge.index_rollback": "Restored the previous library version",
  "knowledge.index.rollback": "Restored the previous library version",
  "admin.cache_flushed": "Cleared saved results",
  "cache.flush": "Cleared saved results",
  "admin.model_test": "Tested a service",
  "evals.run": "Ran a quality check",
  "job.cancelled": "Cancelled a background task",
};

/** Internal service events (provider switches, index refreshes) are not user activity and stay out of the compliance log. */
export const isInternalEvent = (action: string) => /^(llm|index|knowledge\.index|embedding|cache)[._]/i.test(action);

export function actionLabel(action: string): string {
  if (ACTIONS[action]) return ACTIONS[action]!;
  const words = action.replace(/[._]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const ITEMS: Record<string, string> = {
  case: "Case",
  case_document: "Document",
  document: "Document",
  letter: "Letter",
  patient: "Patient record",
  session: "Sign-in session",
  user: "Account",
  organization: "Practice",
  membership: "Team member",
  invitation: "Invitation",
  api_key: "Access key",
  criteria_set: "Requirements checklist",
  index_version: "Policy library version",
  ingestion_run: "Policy library refresh",
  denial: "Denial",
  audit_log: "Activity log",
};

export const itemLabel = (type: string) => ITEMS[type] ?? type.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/** Groups shown as quick filters. Matching is client-side: the log is short and this works the same everywhere. */
export const CATEGORIES: { id: string; label: string; test: (a: string) => boolean }[] = [
  { id: "phi", label: "Patient details viewed", test: (a) => /^phi\.|reveal/.test(a) },
  { id: "access", label: "Sign-ins and access", test: (a) => /^(auth|user)\.|^org\.(member|invitation|api_key)/.test(a) },
  { id: "cases", label: "Cases and letters", test: (a) => /^(case|document|letter|denial)/.test(a) && !/override|review/.test(a) },
  { id: "reviews", label: "Reviews and changes", test: (a) => /override|review|criteria\./.test(a) },
  { id: "library", label: "Policy library", test: (a) => /^knowledge\.|^criteria\./.test(a) },
];

export const isSensitive = (a: string) => /^phi\.|reveal|override|quarantine|rollback|member_removed|member\.remove|api_key/.test(a);

export const actorName = (e: AuditEntry) => e.actor?.fullName ?? e.actorName ?? null;

/** Reads the stated purpose (or the most meaningful detail) recorded with an entry. */
export function purposeOf(e: AuditEntry): string | null {
  const m = e.metadata ?? {};
  const reason = m.reason ?? m.purpose;
  return typeof reason === "string" && reason.trim() ? reason.trim() : null;
}
