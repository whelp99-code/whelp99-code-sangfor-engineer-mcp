# IAG Policy Baseline

## Authentication

Integrate LDAP/AD with read-only service account. Enable MFA for admin and remote access groups.

## Policy order

1. Emergency bypass (documented approver)
2. Admin exception group
3. Default internet access policy
4. Application control overlays

## Audit

Export policy snapshot before changes. Forward logs to SIEM with 90-day retention unless compliance requires longer.
