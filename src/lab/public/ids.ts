import { domainHash, jcsStringify } from "../digest";

export type PublicEvidenceIdKind =
  | "subject"
  | "record"
  | "bundle"
  | "bundle_digest"
  | "artifact"
  | "publisher_key"
  | "revocation"
  | "route_registry";

const PUBLIC_EVIDENCE_DOMAIN: Record<PublicEvidenceIdKind, string> = {
  subject: "epx-lab-public:subject:v1",
  record: "epx-lab-public:record:v1",
  bundle: "epx-lab-public:bundle:v1",
  bundle_digest: "epx-lab-public:bundle-digest:v1",
  artifact: "epx-lab-public:artifact:v1",
  publisher_key: "epx-lab-public:publisher-key:v1",
  revocation: "epx-lab-public:revocation:v1",
  route_registry: "epx-lab-public:route-registry:v1",
};

export function publicEvidenceId(kind: PublicEvidenceIdKind, payload: unknown): string {
  return domainHash(PUBLIC_EVIDENCE_DOMAIN[kind], jcsStringify(payload));
}
