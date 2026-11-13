import type { LetterKind } from "@/lib/api/types";

export const LETTER_KINDS: { kind: LetterKind; label: string; description: string }[] = [
  { kind: "lmn", label: "Letter of medical necessity", description: "Clinician-signed narrative citing chart evidence" },
  { kind: "pa_cover", label: "PA cover letter", description: "Short submission summary with a requirements checklist" },
  { kind: "appeal", label: "Redetermination / appeal", description: "Answers the denial reason requirement by requirement" },
  { kind: "peer_to_peer_prep", label: "Peer-to-peer brief", description: "Talking points for the reviewer call" },
];
