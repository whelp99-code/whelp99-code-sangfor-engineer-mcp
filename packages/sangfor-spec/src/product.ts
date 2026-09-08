/** Product code canonicalization for spec lookup and planner/adapter joins. */

/** Map product aliases to the canonical product code used across planner/adapters/spec joins. */
export function normalizeSpecProduct(input: string): string {
  const s = input.trim().toLowerCase();
  if (/\b(swg|iag|internet access|secure web)\b/.test(s)) return 'IAG';
  if (/\b(epp|endpoint|athena ep|asec)\b/.test(s)) return 'ENDPOINT_SECURE';
  if (/\b(cc|cyber command)\b/.test(s)) return 'CYBER_COMMAND';
  if (/\b(ndr)\b/.test(s)) return 'NDR';
  if (/\b(xdr)\b/.test(s)) return 'XDR';
  if (/\b(ngfw|firewall)\b/.test(s)) return 'NGFW';
  if (/\b(scp|hci\/scp|hci scp|sangfor cloud platform)\b/.test(s)) return 'HCI_SCP';
  if (/\b(hci|asv)\b/.test(s)) return 'HCI';
  return input.trim().toUpperCase();
}

export function specDirectoryCandidates(product: string): string[] {
  const canonical = normalizeSpecProduct(product);
  const legacy: Record<string, string[]> = {
    ENDPOINT_SECURE: ['EPP'],
    CYBER_COMMAND: ['CC'],
    HCI_SCP: ['HCI', 'SCP'],
    IAG: ['SWG'],
  };
  return [canonical, ...(legacy[canonical] ?? [])];
}
