"""Deterministic synthetic FHIR R4 patients (no Synthea/Java needed, no real people).

Names are drawn from obviously-fictional surname lists and phone numbers use the reserved 555-01xx
range, so generated data can never be mistaken for a real patient.
"""

from __future__ import annotations

import base64
import random
import uuid
from dataclasses import dataclass, field
from datetime import date, timedelta

FIRST = [
    "Avery",
    "Jordan",
    "Riley",
    "Morgan",
    "Casey",
    "Quinn",
    "Harper",
    "Rowan",
    "Emerson",
    "Finley",
    "Sawyer",
    "Reese",
    "Dakota",
    "Hayden",
    "Marlowe",
    "Sage",
    "Tatum",
    "Blair",
    "Kendall",
    "Lennon",
]
LAST = [
    "Sampleton",
    "Testwood",
    "Demoura",
    "Mockridge",
    "Fakesley",
    "Placeholt",
    "Synthwell",
    "Dummond",
    "Examplar",
    "Pseudova",
    "Fictor",
    "Proxley",
    "Stubbins",
    "Fixturo",
    "Mockett",
    "Simulani",
]
CITIES = [
    ("Riverbend", "OH"),
    ("Riverbend", "TX"),
    ("Lakeview", "AZ"),
    ("Cedar Falls", "WA"),
    ("Maple Ridge", "NJ"),
    ("Stonebrook", "OK"),
]

DX_DISPLAY = {
    "G47.33": "Obstructive sleep apnea (adult) (pediatric)",
    "M54.16": "Radiculopathy, lumbar region",
    "M54.17": "Radiculopathy, lumbosacral region",
    "M51.16": "Intervertebral disc disorders with radiculopathy, lumbar region",
    "M47.816": "Spondylosis without myelopathy or radiculopathy, lumbar region",
    "M54.50": "Low back pain, unspecified",
    "M17.11": "Unilateral primary osteoarthritis, right knee",
    "S83.241A": "Other tear of medial meniscus, current injury, right knee, initial encounter",
    "M23.221": "Derangement of posterior horn of medial meniscus due to old tear, right knee",
    "H02.831": "Dermatochalasis of right upper eyelid",
    "H02.834": "Dermatochalasis of left upper eyelid",
    "G89.4": "Chronic pain syndrome",
    "M96.1": "Postlaminectomy syndrome, not elsewhere classified",
    "G89.29": "Other chronic pain",
    "I10": "Essential (primary) hypertension",
}
MEDS = [
    "naproxen 500 mg PO BID",
    "meloxicam 15 mg PO daily",
    "gabapentin 300 mg PO TID",
    "duloxetine 60 mg PO daily",
    "acetaminophen 1 g PO TID PRN",
    "cyclobenzaprine 10 mg PO QHS PRN",
    "lisinopril 10 mg PO daily",
    "atorvastatin 20 mg PO daily",
]


@dataclass
class SyntheticPatient:
    full_name: str
    dob: date
    sex: str
    state: str
    city: str
    mrn: str
    member_id: str
    phone: str
    address: str
    patient_uuid: str = field(default_factory=lambda: str(uuid.uuid4()))

    def demographics(self) -> dict:
        return {
            "full_name": self.full_name,
            "dob": self.dob,
            "sex": self.sex,
            "state": self.state,
            "member_id": self.member_id,
            "phone": self.phone,
            "address": self.address,
            "mrn": self.mrn,
        }


def make_patient(
    seed: int | str,
    *,
    state: str | None = None,
    min_age: int = 45,
    max_age: int = 84,
    today: date | None = None,
) -> SyntheticPatient:
    rng = random.Random(f"patient:{seed}")  # noqa: S311
    today = today or date.today()
    city, st = rng.choice(CITIES)
    st = state or st
    age = rng.randint(min_age, max_age)
    dob = today - timedelta(days=age * 365 + rng.randint(0, 364))
    sex = rng.choice(["female", "male"])
    first, last = rng.choice(FIRST), rng.choice(LAST)
    return SyntheticPatient(
        full_name=f"{first} {last}",
        dob=dob,
        sex=sex,
        state=st,
        city=city,
        mrn=f"SYN-{rng.randint(100000, 999999)}",
        member_id=f"SYNM{rng.randint(10_000_000, 99_999_999)}",
        phone=f"(555) 01{rng.randint(10, 99)}-{rng.randint(1000, 9999)}",
        patient_uuid=str(uuid.UUID(int=rng.getrandbits(128), version=4)),
        address=f"{rng.randint(100, 9899)} {rng.choice(['Oak', 'Birch', 'Willow', 'Aspen', 'Juniper'])} "
        f"{rng.choice(['St', 'Ave', 'Ln', 'Ct'])}, {city}, {st}",
    )


def _ref(kind: str, rid: str) -> dict:
    return {"reference": f"{kind}/{rid}"}


def fhir_bundle(
    p: SyntheticPatient,
    *,
    payer_name: str,
    payer_type: str,
    dx_codes: list[str],
    service_codes: list[str],
    documents: list[dict],
    date_of_service: date,
    observations: list[dict] | None = None,
    medications: list[str] | None = None,
    seed: int | str = 0,
) -> dict:
    """FHIR R4 collection Bundle: Patient, Coverage, Condition, ServiceRequest, Observation,
    MedicationRequest and DocumentReference (base64 text/plain notes)."""
    rng = random.Random(f"bundle:{seed}")  # noqa: S311
    pid = p.patient_uuid
    entries: list[dict] = []

    def add(resource: dict) -> None:
        entries.append({"fullUrl": f"urn:uuid:{resource['id']}", "resource": resource})

    first, last = p.full_name.split(" ", 1)
    add(
        {
            "resourceType": "Patient",
            "id": pid,
            "meta": {
                "profile": ["http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient"],
                "tag": [{"system": "urn:necessa:data-origin", "code": "synthetic"}],
            },
            "identifier": [
                {"type": {"text": "Medical Record Number"}, "system": "urn:necessa:mrn", "value": p.mrn}
            ],
            "name": [{"use": "official", "family": last, "given": [first]}],
            "gender": p.sex,
            "birthDate": p.dob.isoformat(),
            "telecom": [{"system": "phone", "value": p.phone, "use": "home"}],
            "address": [
                {"line": [p.address.split(",")[0]], "city": p.city, "state": p.state, "country": "US"}
            ],
        }
    )
    cov_id = str(uuid.uuid4())
    add(
        {
            "resourceType": "Coverage",
            "id": cov_id,
            "status": "active",
            "beneficiary": _ref("Patient", pid),
            "subscriberId": p.member_id,
            "payor": [{"display": payer_name}],
            "type": {"text": payer_type.replace("_", " ").title()},
        }
    )
    for code in dx_codes:
        add(
            {
                "resourceType": "Condition",
                "id": str(uuid.uuid4()),
                "subject": _ref("Patient", pid),
                "clinicalStatus": {
                    "coding": [
                        {
                            "system": "http://terminology.hl7.org/CodeSystem/condition-clinical",
                            "code": "active",
                        }
                    ]
                },
                "code": {
                    "coding": [
                        {
                            "system": "http://hl7.org/fhir/sid/icd-10-cm",
                            "code": code,
                            "display": DX_DISPLAY.get(code, code),
                        }
                    ],
                    "text": DX_DISPLAY.get(code, code),
                },
                "onsetDateTime": (date_of_service - timedelta(days=rng.randint(120, 900))).isoformat(),
            }
        )
    for code in service_codes:
        system = (
            "https://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets"
            if code[:1].isalpha()
            else "http://www.ama-assn.org/go/cpt"
        )
        add(
            {
                "resourceType": "ServiceRequest",
                "id": str(uuid.uuid4()),
                "status": "active",
                "intent": "order",
                "subject": _ref("Patient", pid),
                "code": {"coding": [{"system": system, "code": code}]},
                "occurrenceDateTime": date_of_service.isoformat(),
                "insurance": [_ref("Coverage", cov_id)],
            }
        )
    for obs in observations or []:
        add(
            {
                "resourceType": "Observation",
                "id": str(uuid.uuid4()),
                "status": "final",
                "subject": _ref("Patient", pid),
                "code": {"text": obs["name"]},
                "valueQuantity": {"value": obs["value"], "unit": obs.get("unit", "")},
                "effectiveDateTime": obs.get("date", date_of_service.isoformat()),
            }
        )
    for med in medications or rng.sample(MEDS, 2):
        add(
            {
                "resourceType": "MedicationRequest",
                "id": str(uuid.uuid4()),
                "status": "active",
                "intent": "order",
                "subject": _ref("Patient", pid),
                "medicationCodeableConcept": {"text": med},
            }
        )
    for doc in documents:
        add(
            {
                "resourceType": "DocumentReference",
                "id": str(uuid.uuid4()),
                "status": "current",
                "type": {"text": doc.get("title", "Progress note")},
                "subject": _ref("Patient", pid),
                "date": f"{doc['note_date'].isoformat()}T09:00:00Z",
                "content": [
                    {
                        "attachment": {
                            "contentType": "text/plain",
                            "title": doc.get("title", "note"),
                            "data": base64.b64encode(doc["text"].encode()).decode(),
                        }
                    }
                ],
            }
        )
    return {
        "resourceType": "Bundle",
        "id": str(uuid.uuid4()),
        "type": "collection",
        "meta": {"tag": [{"system": "urn:necessa:data-origin", "code": "synthetic"}]},
        "entry": entries,
    }
