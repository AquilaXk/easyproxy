let credentialMutationEpoch = 0;

/** Process-local fence advanced after every EasyProxy-owned credential publication. */
export function codexCredentialMutationEpoch(): number {
  return credentialMutationEpoch;
}

export function advanceCodexCredentialMutationEpoch(): number {
  credentialMutationEpoch += 1;
  return credentialMutationEpoch;
}
