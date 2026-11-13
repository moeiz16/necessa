/* Demo knowledge base. Source keys, titles, versions and contractors mirror the public CMS
   Medicare Coverage Database; section text is condensed and paraphrased for illustration.
   No CPT® descriptors are included — procedure codes carry Necessa-authored plain-language labels. */

import type { CodeResult, CriteriaSet, DocType, PolicyCode, PolicyDetail, PolicySection } from "@/lib/api/types";

const CONTRACTORS = {
  novitas: { id: 12, name: "Novitas Solutions, Inc." },
  noridian: { id: 3, name: "Noridian Healthcare Solutions, LLC" },
  cgsDme: { id: 140, name: "CGS Administrators, LLC (DME MAC C)" },
  noridianDme: { id: 139, name: "Noridian Healthcare Solutions, LLC (DME MAC D)" },
  palmetto: { id: 11, name: "Palmetto GBA" },
  wps: { id: 5, name: "Wisconsin Physicians Service Insurance Corporation" },
  wellpoint: { id: 6, name: "Wellpoint Federal" },
};

const STATES = {
  novitas: ["TX", "OK", "NM", "CO", "LA", "AR", "MS", "NJ", "PA", "DE", "MD", "DC"],
  noridian: ["AZ", "WA", "OR", "ID", "UT", "MT", "WY", "ND", "SD", "AK", "CA", "NV", "HI"],
  dmeC: ["TX", "OK", "NM", "CO", "LA", "AR", "MS", "AL", "GA", "FL", "TN", "NC", "SC", "VA", "WV", "KY"],
  dmeD: ["AZ", "WA", "OR", "ID", "UT", "MT", "WY", "ND", "SD", "AK", "CA", "NV", "HI", "IA", "KS", "MO", "NE"],
  palmetto: ["AL", "GA", "TN", "NC", "SC", "VA", "WV"],
  wps: ["IA", "KS", "MO", "NE", "IN", "MI"],
  wellpoint: ["MN", "WI", "IL", "NY", "CT", "ME", "MA", "NH", "RI", "VT"],
};

let sectionSeq = 0;
function sec(sectionKey: string, title: string, text: string): PolicySection {
  sectionSeq += 1;
  return { id: `sec-${sectionSeq}`, sectionKey, title, text: text.trim().replace(/\n\s+/g, "\n"), ordinal: sectionSeq };
}

export const ESI_POLICY_TEXT = {
  indication: `Epidural steroid injections (ESI) are considered reasonable and necessary for the treatment of radicular pain when all of the following are documented in the medical record.
Radicular pain is defined as pain radiating along the distribution of a spinal nerve root, supported by history and physical examination findings consistent with nerve root irritation.
The pain must be severe enough to cause a functional deficit, measured on a validated pain or disability scale such as the Oswestry Disability Index (ODI), the Neck Disability Index or a numeric rating scale, recorded before the procedure.
The patient must have failed at least 4 weeks of conservative care, including physical therapy, a home exercise program and/or medications, unless conservative care is contraindicated and the contraindication is documented.
Advanced imaging, when performed, should demonstrate findings consistent with the clinical presentation.`,
  limitations: `ESI must be performed under fluoroscopic or CT guidance with injection of contrast, unless contrast is contraindicated, in which case the contraindication must be documented.
No more than four (4) ESI sessions per region may be performed in a rolling 12 months.
A repeat ESI at the same level requires documentation of at least 50% sustained pain relief or a clinically significant improvement in function lasting at least 3 months from the prior injection.
ESI are not covered in the presence of active systemic or local infection at the injection site, or uncorrected bleeding disorder or anticoagulation that has not been managed per published guidelines.`,
  doc_reqs: `The medical record must contain a complete pre-procedure evaluation including the pain/disability score, the duration and outcome of conservative care, the indication for the specific level and approach, and the absence of contraindications.
For repeat procedures, the record must document the degree and duration of relief from the prior injection.
The procedure note must document imaging guidance, contrast use and the level(s) treated.`,
};

const TKA_TEXT = {
  indication: `Total knee arthroplasty (TKA) is considered reasonable and necessary for advanced joint disease demonstrated by pain or functional disability that interferes with activities of daily living due to osteoarthritis, rheumatoid arthritis, avascular necrosis or post-traumatic arthritis,
AND radiographic evidence of joint space narrowing, subchondral sclerosis, osteophytes, or subchondral cysts,
AND a history of unsuccessful non-surgical treatment for at least 12 weeks, which may include anti-inflammatory medications or analgesics, physical therapy, assistive devices, weight reduction when appropriate, and intra-articular injections.`,
  limitations: `TKA is not reasonable and necessary in the presence of active infection of the joint or active systemic bacteremia, or active skin infection or open wound within the planned surgical site.
Failure of non-surgical treatment must be documented in the medical record and is not required when the patient has a severe deformity or bone-on-bone findings with intractable pain.`,
  doc_reqs: `Documentation must include the history and physical, functional assessment, imaging report and the details of non-surgical therapies with dates and outcomes.`,
};

const PAP_TEXT = {
  indication: `A positive airway pressure (PAP) device is covered for the treatment of obstructive sleep apnea (OSA) for an initial 12-week period if the beneficiary has a face-to-face clinical evaluation by the treating practitioner prior to the sleep test,
AND a sleep test meets either of the following criteria: the apnea-hypopnea index (AHI) or respiratory disturbance index (RDI) is greater than or equal to 15 events per hour with a minimum of 30 events; or the AHI or RDI is greater than or equal to 5 and less than or equal to 14 events per hour with a minimum of 10 events and documentation of excessive daytime sleepiness, impaired cognition, mood disorders, insomnia, hypertension, ischemic heart disease, or history of stroke,
AND the beneficiary and/or their caregiver has received instruction from the supplier of the device in the proper use and care of the equipment.`,
  limitations: `Continued coverage beyond the first 12 weeks requires a clinical re-evaluation between the 31st and 91st day after initiating therapy documenting that symptoms of OSA are improved, and objective evidence of adherence to use of the PAP device, defined as use of PAP 4 or more hours per night on 70% of nights during a consecutive thirty (30) day period anytime during the first three (3) months of initial usage.`,
  doc_reqs: `Suppliers must have a valid standard written order and the sleep study report available upon request. Adherence data must be downloaded from the device.`,
};

const SCS_TEXT = {
  indication: `Spinal cord stimulation (SCS) is considered reasonable and necessary for chronic intractable pain of the trunk or limbs when there is documented failure of at least 6 months of conservative multimodal treatment,
AND the patient has undergone a psychological evaluation by a licensed mental health professional that did not identify contraindicating conditions,
AND a trial of temporarily implanted electrodes has been successful, defined as at least 50% reduction in pain and improvement in function documented during the trial.`,
  limitations: `Permanent implantation is not covered without a successful trial. SCS is not covered when the patient has untreated substance use disorder, active infection, or an inability to properly operate the device.`,
  doc_reqs: `The record must include the conservative therapies tried with dates, the psychological evaluation report, and the trial outcome with pre- and post-trial pain and function scores.`,
};

const PVA_TEXT = {
  indication: `Percutaneous vertebral augmentation is covered for painful osteoporotic vertebral compression fractures when the fracture is confirmed by imaging, the pain is not responding to at least 3 weeks of nonsurgical management or is causing hospitalization, and the fracture is acute or subacute (generally less than one year old) with edema on MRI or increased uptake on bone scan.`,
  limitations: `Vertebral augmentation is not covered for asymptomatic fractures, chronic healed fractures without edema, or as prophylaxis in osteoporosis.`,
  doc_reqs: `Documentation must include the imaging report demonstrating an acute or subacute fracture, pain scores, the nonsurgical treatment provided and its duration, and the functional impact.`,
};

const MRI_TEXT = {
  indication: `Lumbar spine MRI is reasonable and necessary for low back pain with red-flag findings (suspected cancer, infection, cauda equina syndrome, fracture, progressive neurological deficit), or for radiculopathy or spinal stenosis persisting after at least 6 weeks of conservative care in a patient who is a candidate for intervention.`,
  limitations: `MRI is not reasonable and necessary for uncomplicated acute low back pain of less than 6 weeks' duration without red flags.`,
  doc_reqs: `The order must document the clinical indication, duration of symptoms, conservative care provided and any red-flag findings.`,
};

const PMD_TEXT = {
  indication: `A power mobility device is covered if the beneficiary has a mobility limitation that significantly impairs their ability to participate in one or more mobility-related activities of daily living in the home, the limitation cannot be sufficiently resolved by an appropriately fitted cane, walker or optimally configured manual wheelchair, and the beneficiary has sufficient strength, postural stability and mental capability to safely operate the device.`,
  limitations: `A face-to-face examination and a written order are required before delivery. A home assessment must verify that the device can be used in the home.`,
  doc_reqs: `The treating practitioner's face-to-face examination must document the mobility limitation and why lesser devices are insufficient.`,
};

function generic(title: string): { indication: string; limitations: string; doc_reqs: string } {
  return {
    indication: `${title} is considered reasonable and necessary when the indications described in this policy are met and documented in the medical record, including the clinical history, examination findings, prior treatment and its outcome.`,
    limitations: `Services that do not meet the indications described above, or that are performed more frequently than described, are not considered reasonable and necessary.`,
    doc_reqs: `The medical record must support the medical necessity of the service and be available upon request.`,
  };
}

interface Seed {
  key: string;
  title: string;
  docType: DocType;
  version: number;
  eff: string;
  contractor: keyof typeof CONTRACTORS;
  states: string[];
  text?: { indication: string; limitations: string; doc_reqs: string };
  linked?: string[];
  hasCriteria?: boolean;
  codes?: number;
}


const FACET_TEXT = {
  indication: `Facet joint interventions are considered reasonable and necessary for chronic axial neck or low back pain when all of the following are documented.
1. Moderate to severe chronic neck or low back pain, predominantly axial, that causes functional deficit measured on pain or disability scale
2. Pain present for minimum of 3 months with documented failure to respond to noninvasive conservative management (as tolerated)
3. Absence of untreated radiculopathy or neurogenic claudication (except for radiculopathy caused by facet joint synovial cyst)
4. There is no non-facet pathology per clinical assessment or radiology studies that could explain the source of the patient's pain, including but not limited to fracture, tumor, infection, or significant deformity.`,
  limitations: `Diagnostic facet joint procedures require a minimum of 80% relief of primary (index) pain for a duration consistent with the agent used.
No more than four (4) diagnostic joint sessions will be reimbursed per rolling 12 months.`,
  doc_reqs: `Pain assessment must be performed and documented at baseline, after each diagnostic procedure using the same pain scale for each assessment.
The medical record must document the duration of relief after each diagnostic procedure.`,
};

const SEEDS: Seed[] = [
  { key: "L38801", title: "Facet Joint Interventions for Pain Management", docType: "LCD", version: 12, eff: "2026-04-16", contractor: "noridian", states: STATES.noridian, text: FACET_TEXT, linked: [], codes: 6 },
  { key: "L36920", title: "Epidural Steroid Injections for Pain Management", docType: "LCD", version: 107, eff: "2026-04-09", contractor: "novitas", states: STATES.novitas, text: ESI_POLICY_TEXT, linked: ["A56681"], hasCriteria: true, codes: 9 },
  { key: "A56681", title: "Billing and Coding: Epidural Steroid Injections for Pain Management", docType: "Billing and Coding", version: 31, eff: "2023-11-16", contractor: "novitas", states: STATES.novitas, linked: ["L36920"], codes: 184 },
  { key: "L36575", title: "Total Knee Arthroplasty", docType: "LCD", version: 21, eff: "2025-11-06", contractor: "noridian", states: STATES.noridian, text: TKA_TEXT, linked: ["A57685"], hasCriteria: true, codes: 2 },
  { key: "A57685", title: "Billing and Coding: Total Knee Arthroplasty", docType: "Billing and Coding", version: 14, eff: "2026-01-01", contractor: "noridian", states: STATES.noridian, linked: ["L36575"], codes: 96 },
  { key: "L33718", title: "Positive Airway Pressure (PAP) Devices for the Treatment of Obstructive Sleep Apnea", docType: "LCD", version: 52, eff: "2024-01-01", contractor: "cgsDme", states: STATES.dmeC, text: PAP_TEXT, linked: ["A52467", "A55426"], hasCriteria: true, codes: 6 },
  { key: "A52467", title: "Positive Airway Pressure (PAP) Devices for the Treatment of Obstructive Sleep Apnea – Policy Article", docType: "Article", version: 18, eff: "2021-08-08", contractor: "cgsDme", states: STATES.dmeC, linked: ["L33718"], codes: 6 },
  { key: "A55426", title: "Standard Documentation Requirements for All Claims Submitted to DME MACs", docType: "Article", version: 22, eff: "2024-01-01", contractor: "cgsDme", states: STATES.dmeC, linked: ["L33718", "L33789"], codes: 0 },
  { key: "L35136", title: "Spinal Cord Stimulators for Chronic Pain", docType: "LCD", version: 37, eff: "2025-10-16", contractor: "noridian", states: STATES.noridian, text: SCS_TEXT, linked: ["A57791"], hasCriteria: true, codes: 8 },
  { key: "A57791", title: "Billing and Coding: Spinal Cord Stimulators for Chronic Pain", docType: "Billing and Coding", version: 19, eff: "2025-10-16", contractor: "noridian", states: STATES.noridian, linked: ["L35136"], codes: 142 },
  { key: "L34228", title: "Percutaneous Vertebral Augmentation (PVA) for Osteoporotic Vertebral Compression Fracture (VCF)", docType: "LCD", version: 54, eff: "2025-11-20", contractor: "noridian", states: STATES.noridian, text: PVA_TEXT, linked: ["A56572"], hasCriteria: true, codes: 4 },
  { key: "A56572", title: "Billing and Coding: Percutaneous Vertebral Augmentation (PVA) for Osteoporotic Vertebral Compression Fracture (VCF)", docType: "Billing and Coding", version: 27, eff: "2025-11-06", contractor: "noridian", states: STATES.noridian, linked: ["L34228"], codes: 61 },
  { key: "L34220", title: "Lumbar MRI", docType: "LCD", version: 40, eff: "2025-10-23", contractor: "noridian", states: STATES.noridian, text: MRI_TEXT, linked: ["A57206"], hasCriteria: true, codes: 3 },
  { key: "A57206", title: "Billing and Coding: Lumbar MRI", docType: "Billing and Coding", version: 12, eff: "2026-10-01", contractor: "noridian", states: STATES.noridian, linked: ["L34220"], codes: 210 },
  { key: "L33789", title: "Power Mobility Devices", docType: "LCD", version: 49, eff: "2026-12-20", contractor: "cgsDme", states: STATES.dmeC, text: PMD_TEXT, linked: ["A52498", "A55426"], hasCriteria: false, codes: 58 },
  { key: "A52498", title: "Power Mobility Devices - Policy Article", docType: "Article", version: 33, eff: "2026-12-20", contractor: "cgsDme", states: STATES.dmeC, linked: ["L33789"], codes: 58 },
  { key: "L37848", title: "Lumbar Spinal Fusion", docType: "LCD", version: 18, eff: "2024-09-12", contractor: "palmetto", states: STATES.palmetto, linked: ["A56396"], hasCriteria: false, codes: 12 },
  { key: "A56396", title: "Billing and Coding: Lumbar Spinal Fusion", docType: "Billing and Coding", version: 9, eff: "2023-01-01", contractor: "palmetto", states: STATES.palmetto, linked: ["L37848"], codes: 77 },
  { key: "L39529", title: "Intraarticular Knee Injections of Hyaluronan", docType: "LCD", version: 5, eff: "2025-05-01", contractor: "wps", states: STATES.wps, linked: ["A56157"], codes: 7 },
  { key: "A56157", title: "Billing and Coding: Intraarticular Knee Injections of Hyaluronan", docType: "Billing and Coding", version: 16, eff: "2026-06-25", contractor: "wps", states: STATES.wps, linked: ["L39529"], codes: 48 },
  { key: "L39770", title: "Cervical Fusion", docType: "LCD", version: 15, eff: "2026-04-09", contractor: "wellpoint", states: STATES.wellpoint, linked: ["A59632"], codes: 10 },
  { key: "A59632", title: "Billing and Coding: Cervical Fusion", docType: "Billing and Coding", version: 6, eff: "2026-04-09", contractor: "wellpoint", states: STATES.wellpoint, linked: ["L39770"], codes: 64 },
  { key: "A52369", title: "Billing and Coding: Arthroscopic Lavage and Arthroscopic Debridement for the Osteoarthritic Knee – Medical Policy Article", docType: "Billing and Coding", version: 17, eff: "2026-04-01", contractor: "noridian", states: STATES.noridian, linked: ["NCD-150.9"], codes: 3 },
  { key: "NCD-150.9", title: "Arthroscopic Lavage and Arthroscopic Debridement for the Osteoarthritic Knee", docType: "NCD", version: 1, eff: "2004-07-03", contractor: "noridian", states: [], linked: ["A52369"], codes: 0 },
  { key: "NCD-240.4", title: "Continuous Positive Airway Pressure (CPAP) Therapy for Obstructive Sleep Apnea (OSA)", docType: "NCD", version: 2, eff: "2008-03-13", contractor: "cgsDme", states: [], linked: ["L33718"], codes: 0 },
  { key: "NCD-160.7", title: "Electrical Nerve Stimulators", docType: "NCD", version: 1, eff: "1995-08-07", contractor: "noridian", states: [], linked: ["L35136"], codes: 0 },
  { key: "NCD-280.3", title: "Mobility Assistive Equipment (MAE)", docType: "NCD", version: 1, eff: "2005-05-05", contractor: "cgsDme", states: [], linked: ["L33789"], codes: 0 },
];

function idFor(key: string) {
  return `pol-${key.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}
export const policyIdFor = idFor;
export const versionIdFor = (key: string, v: number) => `${idFor(key)}-v${v}`;

export function buildPolicies(): PolicyDetail[] {
  sectionSeq = 0;
  const byKey = new Map(SEEDS.map((s) => [s.key, s]));
  return SEEDS.map((s) => {
    const text = s.text ?? generic(s.title);
    const isNcd = s.docType === "NCD";
    const sections: PolicySection[] =
      s.docType === "Billing and Coding" || s.docType === "Article"
        ? [
            sec("description", "Article Guidance", `${text.indication}\n\nThis article contains billing and coding guidance for ${s.title.replace(/^Billing and Coding: /, "")}. Refer to the related LCD for coverage indications and limitations.`),
            sec("coding_guidelines", "Coding Guidelines", `Report the procedure code that accurately describes the service performed. Diagnosis codes must be reported to the highest level of specificity. The ICD-10-CM codes listed in Group 1 support medical necessity when the coverage indications in the related LCD are met.`),
            sec("doc_reqs", "Documentation Requirements", text.doc_reqs),
          ]
        : [
            sec(isNcd ? "item_service" : "indication", isNcd ? "Item/Service Description" : "Coverage Indications, Limitations, and/or Medical Necessity", text.indication),
            sec("limitations", isNcd ? "Indications and Limitations of Coverage" : "Limitations", text.limitations),
            sec("doc_reqs", "Documentation Requirements", text.doc_reqs),
            sec("summary_of_evidence", "Summary of Evidence", `The contractor reviewed peer-reviewed literature, specialty society guidelines and comments received during the open comment period. Evidence supports coverage when the criteria above are met; evidence is insufficient outside these indications.`),
          ];
    const versions = [s.version, s.version - 1, s.version - 2]
      .filter((v) => v > 0)
      .map((v, i) => ({
        id: versionIdFor(s.key, v),
        version: v,
        effectiveFrom: i === 0 ? s.eff : shiftDate(s.eff, -180 * i),
        effectiveTo: i === 0 ? null : shiftDate(s.eff, -180 * (i - 1) - 1),
        lastUpdated: `${i === 0 ? s.eff : shiftDate(s.eff, -180 * i)}T14:22:07Z`,
        summary:
          i === 0
            ? "Revised documentation requirements and clarified frequency limits."
            : i === 1
              ? "Annual ICD-10-CM code update; formatting changes."
              : "Initial publication of this version.",
      }));
    const c = CONTRACTORS[s.contractor];
    return {
      id: idFor(s.key),
      sourceKey: s.key,
      title: s.title,
      docType: s.docType,
      status: s.eff > "2026-11-13" ? "future" : "active",
      version: s.version,
      effectiveFrom: s.eff,
      effectiveTo: null,
      contractors: isNcd ? [] : [c],
      states: s.states,
      codeCount: s.codes ?? 0,
      hasCriteria: !!s.hasCriteria,
      url: `https://www.cms.gov/medicare-coverage-database/view/${s.docType === "LCD" ? "lcd" : isNcd ? "ncd" : "article"}.aspx`,
      keywords: null,
      currentVersionId: versionIdFor(s.key, s.version),
      sections,
      versions,
      linked: (s.linked ?? [])
        .map((k) => byKey.get(k))
        .filter((x): x is Seed => !!x)
        .map((l) => ({
          policyId: idFor(l.key),
          sourceKey: l.key,
          title: l.title,
          docType: l.docType,
          relation: l.docType === "LCD" ? "article_lcd" : l.docType === "NCD" ? "lcd_ncd" : "lcd_article",
        })),
      codeCounts: (s.codes
        ? { HCPCS: Math.min(s.codes, 9), ICD10_COVERED: Math.max(0, s.codes - 9), ICD10_NONCOVERED: s.docType === "Billing and Coding" ? 12 : 0 }
        : {}) as Record<string, number>,
    } satisfies PolicyDetail;
  });
}

function shiftDate(iso: string, days: number) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/* ── Code sets (HCPCS Level II + ICD-10-CM are public domain; procedure labels are our own) ── */
export const CODES: CodeResult[] = [
  { system: "HCPCS", code: "64483", shortDesc: "Transforaminal epidural injection, lumbar/sacral, single level (imaging guided)" },
  { system: "HCPCS", code: "64484", shortDesc: "Transforaminal epidural injection, lumbar/sacral, each additional level" },
  { system: "HCPCS", code: "62323", shortDesc: "Interlaminar epidural injection, lumbar/sacral (imaging guided)" },
  { system: "HCPCS", code: "64493", shortDesc: "Paravertebral facet joint injection, lumbar/sacral, single level" },
  { system: "HCPCS", code: "64635", shortDesc: "Radiofrequency ablation, lumbar/sacral facet joint nerves, single level" },
  { system: "HCPCS", code: "27447", shortDesc: "Total knee arthroplasty" },
  { system: "HCPCS", code: "63650", shortDesc: "Spinal cord stimulator trial lead placement" },
  { system: "HCPCS", code: "63685", shortDesc: "Spinal cord stimulator generator placement" },
  { system: "HCPCS", code: "22514", shortDesc: "Percutaneous vertebral augmentation, lumbar, single level" },
  { system: "HCPCS", code: "72148", shortDesc: "MRI lumbar spine without contrast" },
  { system: "HCPCS", code: "E0601", shortDesc: "Continuous positive airway pressure (CPAP) device", longDesc: "Continuous positive airway pressure (CPAP) device" },
  { system: "HCPCS", code: "E0470", shortDesc: "Respiratory assist device, bi-level pressure, without backup rate" },
  { system: "HCPCS", code: "K0823", shortDesc: "Power wheelchair, group 2 standard, captain's chair" },
  { system: "HCPCS", code: "J7321", shortDesc: "Hyaluronan or derivative, for intra-articular injection, per dose" },
  { system: "ICD10CM", code: "M54.16", shortDesc: "Radiculopathy, lumbar region" },
  { system: "ICD10CM", code: "M54.17", shortDesc: "Radiculopathy, lumbosacral region" },
  { system: "ICD10CM", code: "M51.16", shortDesc: "Intervertebral disc disorders with radiculopathy, lumbar region" },
  { system: "ICD10CM", code: "M48.062", shortDesc: "Spinal stenosis, lumbar region with neurogenic claudication" },
  { system: "ICD10CM", code: "M47.816", shortDesc: "Spondylosis without myelopathy or radiculopathy, lumbar region" },
  { system: "ICD10CM", code: "M17.11", shortDesc: "Unilateral primary osteoarthritis, right knee" },
  { system: "ICD10CM", code: "M17.12", shortDesc: "Unilateral primary osteoarthritis, left knee" },
  { system: "ICD10CM", code: "M96.1", shortDesc: "Postlaminectomy syndrome, not elsewhere classified" },
  { system: "ICD10CM", code: "G89.4", shortDesc: "Chronic pain syndrome" },
  { system: "ICD10CM", code: "M80.08XA", shortDesc: "Age-related osteoporosis with current pathological fracture, vertebra(e), initial encounter" },
  { system: "ICD10CM", code: "M54.50", shortDesc: "Low back pain, unspecified" },
  { system: "ICD10CM", code: "G47.33", shortDesc: "Obstructive sleep apnea (adult) (pediatric)" },
  { system: "ICD10CM", code: "G35", shortDesc: "Multiple sclerosis" },
  { system: "ICD10CM", code: "I69.351", shortDesc: "Hemiplegia and hemiparesis following cerebral infarction affecting right dominant side" },
];

export function buildPolicyCodes(policy: PolicyDetail): PolicyCode[] {
  const hcpcs = CODES.filter((c) => c.system === "HCPCS");
  const icd = CODES.filter((c) => c.system === "ICD10CM");
  const pick = (title: string) => {
    const t = title.toLowerCase();
    if (t.includes("epidural")) return { h: ["64483", "64484", "62323"], d: ["M54.16", "M54.17", "M51.16", "M48.062"] };
    if (t.includes("knee arthroplasty")) return { h: ["27447"], d: ["M17.11", "M17.12"] };
    if (t.includes("airway") || t.includes("cpap")) return { h: ["E0601", "E0470"], d: ["G47.33"] };
    if (t.includes("spinal cord")) return { h: ["63650", "63685"], d: ["M96.1", "G89.4"] };
    if (t.includes("vertebral")) return { h: ["22514"], d: ["M80.08XA"] };
    if (t.includes("lumbar mri")) return { h: ["72148"], d: ["M54.16", "M54.50", "M48.062"] };
    if (t.includes("mobility")) return { h: ["K0823"], d: ["G35", "I69.351"] };
    if (t.includes("hyaluronan")) return { h: ["J7321"], d: ["M17.11", "M17.12"] };
    if (t.includes("facet")) return { h: ["64493", "64635"], d: ["M47.816"] };
    return { h: [], d: [] };
  };
  const p = pick(policy.title);
  const out: PolicyCode[] = [];
  p.h.forEach((code) => {
    const c = hcpcs.find((x) => x.code === code)!;
    out.push({ codeSystem: "HCPCS", code, groupNo: 1, description: c.shortDesc });
  });
  p.d.forEach((code, i) => {
    const c = icd.find((x) => x.code === code)!;
    out.push({ codeSystem: "ICD10_COVERED", code, groupNo: i < 2 ? 1 : 2, description: c.shortDesc });
  });
  if (policy.docType === "Billing and Coding" && p.d.length) {
    out.push({ codeSystem: "ICD10_NONCOVERED", code: "M54.50", groupNo: 1, description: "Low back pain, unspecified" });
  }
  return out;
}

/* ── Compiled criteria sets ──────────────────────────────────────────────── */
export function buildCriteriaSets(policies: PolicyDetail[]): CriteriaSet[] {
  const byKey = new Map(policies.map((p) => [p.sourceKey, p]));
  const esi = byKey.get("L36920")!;
  const tka = byKey.get("L36575")!;
  const pap = byKey.get("L33718")!;
  const scs = byKey.get("L35136")!;
  const pva = byKey.get("L34228")!;
  const mri = byKey.get("L34220")!;
  const base = (p: PolicyDetail) => ({
    policyVersionId: p.currentVersionId,
    policyTitle: p.title,
    sourceKey: p.sourceKey,
    version: p.version,
  });
  return [
    {
      id: "crit-esi",
      ...base(esi),
      status: "approved",
      tree: ESI_TREE,
      extractorModel: "gemini/gemini-2.5-flash",
      verifierModel: "groq/openai/gpt-oss-120b",
      agreement: 0.94,
      groundingPassRate: 1,
      notes: "The frequency limit is checked as a number. Anticoagulation is covered by the must-be-confirmed requirement.",
      reviewedBy: { id: "u-tessa", fullName: "Priya Natarajan, RN" },
      reviewedAt: "2026-10-02T15:41:00Z",
      createdAt: "2026-10-01T09:12:00Z",
    },
    {
      id: "crit-tka",
      ...base(tka),
      status: "approved",
      tree: TKA_TREE,
      extractorModel: "gemini/gemini-2.5-flash",
      verifierModel: "groq/openai/gpt-oss-120b",
      agreement: 0.97,
      groundingPassRate: 1,
      reviewedBy: { id: "u-sam", fullName: "Dr. Sam Whitfield" },
      reviewedAt: "2026-09-21T18:03:00Z",
      createdAt: "2026-09-20T08:00:00Z",
    },
    {
      id: "crit-pap",
      ...base(pap),
      status: "approved",
      tree: PAP_TREE,
      extractorModel: "gemini/gemini-2.5-flash",
      verifierModel: "groq/qwen/qwen3-32b",
      agreement: 0.91,
      groundingPassRate: 1,
      reviewedBy: { id: "u-tessa", fullName: "Priya Natarajan, RN" },
      reviewedAt: "2026-08-14T12:00:00Z",
      createdAt: "2026-08-13T10:00:00Z",
    },
    {
      id: "crit-scs",
      ...base(scs),
      status: "needs_review",
      tree: SCS_TREE,
      extractorModel: "gemini/gemini-2.5-flash",
      verifierModel: "groq/openai/gpt-oss-120b",
      agreement: 0.78,
      groundingPassRate: 0.83,
      notes: "A second check split the psychological evaluation into two requirements. One quote needs its spacing fixed to match the policy.",
      createdAt: "2026-11-11T07:30:00Z",
    },
    {
      id: "crit-pva",
      ...base(pva),
      status: "needs_review",
      tree: {
        op: "AND",
        children: [
          { id: "C1", text: "Vertebral compression fracture confirmed by imaging", kind: "documentation", sourceSpan: { section: "indication", quote: "the fracture is confirmed by imaging" } },
          { id: "C2", text: "Pain unresponsive to ≥ 3 weeks of nonsurgical management, or causing hospitalization", kind: "temporal", lookbackDays: 120, sourceSpan: { section: "indication", quote: "not responding to at least 3 weeks of nonsurgical management or is causing hospitalization" } },
          { id: "C3", text: "Fracture acute or subacute with MRI edema or bone-scan uptake", kind: "positive", sourceSpan: { section: "indication", quote: "the fracture is acute or subacute (generally less than one year old) with edema on MRI or increased uptake on bone scan" } },
        ],
      },
      extractorModel: "gemini/gemini-2.5-flash",
      verifierModel: "groq/openai/gpt-oss-120b",
      agreement: 0.86,
      groundingPassRate: 1,
      createdAt: "2026-11-12T07:30:00Z",
    },
    {
      id: "crit-facet-l38801",
      ...base(byKey.get("L38801")!),
      status: "needs_review",
      tree: {
        op: "AND",
        children: [
          { id: "C1", text: "Moderate to severe chronic axial pain causing functional deficit on a pain or disability scale", kind: "positive", sourceSpan: { section: "indication", quote: "Moderate to severe chronic neck or low back pain, predominantly axial, that causes functional deficit measured on pain or disability scale" } },
          { id: "C2", text: "≥ 3 months of pain with failed noninvasive conservative care", kind: "temporal", lookbackDays: 365, sourceSpan: { section: "indication", quote: "Pain that has been present for a minimum of three months with documented failure to respond to noninvasive conservative care management (as tolerated)" } },
          { id: "C3", text: "No untreated radiculopathy or neurogenic claudication", kind: "negative_attestation", sourceSpan: { section: "indication", quote: "Absence of untreated radiculopathy or neurogenic claudication (except for radiculopathy caused by facet joint synovial cyst)" } },
          { id: "C4", text: "No non-facet pathology explains the pain", kind: "negative_attestation", sourceSpan: { section: "indication", quote: "There is no non-facet pathology per clinical assessment or radiology studies that could explain the source of the patient's pain" } },
          { id: "C5", text: "Baseline and post-procedure pain scores on the same scale", kind: "documentation", sourceSpan: { section: "doc_reqs", quote: "Pain assessment must be performed and documented at baseline, after each diagnostic procedure using the same pain scale for each assessment." } },
        ],
      },
      extractorModel: "transfer:L33930",
      verifierModel: "verbatim-grounding",
      agreement: 0.8,
      groundingPassRate: 0.8,
      notes: "Imported from L33930, another contractor's edition of this policy. 4 of 5 quotes match L38801. Requirement C2 is worded differently here and must be updated before it is used.",
      createdAt: "2026-11-13T06:10:00Z",
    },
    {
      id: "crit-mri",
      ...base(mri),
      status: "approved",
      tree: {
        op: "OR",
        children: [
          { id: "C1", text: "Red-flag findings documented (cancer, infection, cauda equina, fracture, progressive deficit)", kind: "positive", sourceSpan: { section: "indication", quote: "low back pain with red-flag findings" } },
          {
            op: "AND",
            children: [
              { id: "C2", text: "Radiculopathy or spinal stenosis", kind: "positive", sourceSpan: { section: "indication", quote: "radiculopathy or spinal stenosis persisting" } },
              { id: "C3", text: "≥ 6 weeks of conservative care completed", kind: "temporal", lookbackDays: 180, sourceSpan: { section: "indication", quote: "after at least 6 weeks of conservative care" } },
              { id: "C4", text: "Patient is a candidate for intervention", kind: "documentation", sourceSpan: { section: "indication", quote: "a candidate for intervention" } },
            ],
          },
        ],
      },
      extractorModel: "gemini/gemini-2.5-flash",
      verifierModel: "groq/openai/gpt-oss-120b",
      agreement: 0.95,
      groundingPassRate: 1,
      reviewedBy: { id: "u-tessa", fullName: "Priya Natarajan, RN" },
      reviewedAt: "2026-10-30T10:00:00Z",
      createdAt: "2026-10-29T10:00:00Z",
    },
  ];
}

export const ESI_TREE = {
  op: "AND" as const,
  children: [
    { id: "C1", text: "Radicular pain supported by history and physical examination", kind: "positive" as const, evidenceType: ["note"], sourceSpan: { section: "indication", quote: "supported by history and physical examination findings consistent with nerve root irritation" } },
    { id: "C2", text: "Functional deficit measured on a validated pain/disability scale", kind: "numeric" as const, evidenceType: ["note"], sourceSpan: { section: "indication", quote: "measured on a validated pain or disability scale" } },
    { id: "C3", text: "≥ 4 weeks of failed conservative care (PT, home exercise and/or medications)", kind: "temporal" as const, lookbackDays: 180, evidenceType: ["therapy_note", "note"], sourceSpan: { section: "indication", quote: "failed at least 4 weeks of conservative care" } },
    { id: "C4", text: "Imaging consistent with the clinical presentation", kind: "documentation" as const, evidenceType: ["imaging_report"], sourceSpan: { section: "indication", quote: "should demonstrate findings consistent with the clinical presentation" } },
    { id: "C5", text: "Fluoroscopic or CT guidance with contrast planned", kind: "documentation" as const, evidenceType: ["note"], sourceSpan: { section: "limitations", quote: "under fluoroscopic or CT guidance with injection of contrast" } },
    { id: "C6", text: "≤ 4 ESI sessions in this region in a rolling 12 months", kind: "numeric" as const, evidenceType: ["procedure"], sourceSpan: { section: "limitations", quote: "No more than four (4) ESI sessions per region" } },
    { id: "C7", text: "No active infection or unmanaged anticoagulation (attestation)", kind: "negative_attestation" as const, evidenceType: ["note"], sourceSpan: { section: "limitations", quote: "not covered in the presence of active systemic or local infection" } },
  ],
};

const TKA_TREE = {
  op: "AND" as const,
  children: [
    { id: "C1", text: "Pain or functional disability interfering with ADLs from advanced joint disease", kind: "positive" as const, sourceSpan: { section: "indication", quote: "pain or functional disability that interferes with activities of daily living" } },
    { id: "C2", text: "Radiographic evidence of advanced arthritis", kind: "documentation" as const, sourceSpan: { section: "indication", quote: "radiographic evidence of joint space narrowing" } },
    {
      op: "OR" as const,
      children: [
        { id: "C3", text: "≥ 12 weeks of unsuccessful non-surgical treatment", kind: "temporal" as const, lookbackDays: 365, sourceSpan: { section: "indication", quote: "unsuccessful non-surgical treatment for at least 12 weeks" } },
        { id: "C4", text: "Severe deformity or bone-on-bone findings with intractable pain", kind: "positive" as const, sourceSpan: { section: "limitations", quote: "severe deformity or bone-on-bone findings with intractable pain" } },
      ],
    },
    { id: "C5", text: "No active joint, systemic or skin infection at surgical site (attestation)", kind: "negative_attestation" as const, sourceSpan: { section: "limitations", quote: "not reasonable and necessary in the presence of active infection" } },
  ],
};

const PAP_TREE = {
  op: "AND" as const,
  children: [
    { id: "C1", text: "Face-to-face clinical evaluation before the sleep test", kind: "documentation" as const, sourceSpan: { section: "indication", quote: "face-to-face clinical evaluation by the treating practitioner prior to the sleep test" } },
    {
      op: "OR" as const,
      children: [
        { id: "C2", text: "AHI/RDI ≥ 15 events/hour (minimum 30 events)", kind: "numeric" as const, sourceSpan: { section: "indication", quote: "greater than or equal to 15 events per hour with a minimum of 30 events" } },
        { id: "C3", text: "AHI/RDI 5–14 with qualifying symptoms or comorbidity", kind: "numeric" as const, sourceSpan: { section: "indication", quote: "greater than or equal to 5 and less than or equal to 14 events per hour" } },
      ],
    },
    { id: "C4", text: "Supplier instruction on proper use and care", kind: "documentation" as const, sourceSpan: { section: "indication", quote: "received instruction from the supplier of the device" } },
  ],
};

const SCS_TREE = {
  op: "AND" as const,
  children: [
    { id: "C1", text: "≥ 6 months of failed conservative multimodal treatment", kind: "temporal" as const, lookbackDays: 540, sourceSpan: { section: "indication", quote: "failure of at least 6 months of conservative multimodal treatment" } },
    { id: "C2", text: "Psychological evaluation without contraindicating conditions", kind: "documentation" as const, sourceSpan: { section: "indication", quote: "psychological evaluation by a licensed mental health professional" } },
    { id: "C3", text: "Successful trial: ≥ 50% pain reduction with functional improvement", kind: "numeric" as const, sourceSpan: { section: "indication", quote: "at least 50% reduction in pain and improvement in function" } },
    { id: "C4", text: "No untreated substance use disorder or active infection (attestation)", kind: "negative_attestation" as const, sourceSpan: { section: "limitations", quote: "untreated substance use disorder, active infection" } },
  ],
};
