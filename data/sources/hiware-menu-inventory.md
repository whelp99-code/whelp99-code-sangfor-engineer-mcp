---
product: HIWARE
sourceType: manual
trustLevel: internal
observedAt: 2026-08-22
status: sanitized_observation
---

# HIWARE 6 privileged access menu inventory

This source was derived from a read-only review of an authenticated HIWARE 6
console. Customer addresses, session identifiers, account identifiers, license
material, and other environment-specific identifiers were removed before
persistence. Empty screens mean only that no rows were visible to the observed
account; they do not prove that the feature is unused.

## Safety boundary

- The review did not invoke Save, Apply, Add, Delete, Modify, Release, Reset,
  Restart, or Run.
- Password reveal/change, OTP registration, and license-key inspection were
  intentionally excluded.
- Any future configuration requires customer approval, an exact change plan,
  and independent read-back.

## Coverage

- 90 unique menus or subviews were observed.
- PSM for System: 46.
- Preferences: 28.
- Approval: 16.
- 35 screens exposed data or structure.
- 55 screens loaded successfully with no visible rows.
- No menu remained unclassified.

## PSM for System menus

The following screens loaded with no visible rows:

- Access Cause
- Access History by Command
- Access History by Equipment
- Access History by Period
- Access History by Protocol
- Access History by User
- Access Management Report
- Access Permission By Entire Access
- Access Permission Policy
- Access Restriction Policy
- Access permission by role
- Access permission by user
- Allow Period
- Command Restriction
- Day Restriction
- Device Specific Access Privilege
- Equipment Access Security Alert
- Equipment Specific Restriction Policy
- Exception Setting
- Manage Password
- Manage access account
- Manage account linkage
- Manage account task
- Management of SSH KEY
- Multiple Equipment Access
- Protocol
- Real-time Session Detail Status
- Real-time Session Status
- Reason Specific Access History
- Revoked Permission Management
- SU Only
- Session Option
- System Access History
- Task Logging
- Test Account Connectivity
- Two-Factor authentication
- Use History by Time

The following screens exposed structure or data:

- Access Permission Setting
- Access Security Policy
- Code Setting Status
- Dangerous Behavior History
- Individual Access Permission
- Management Code
- Script Management
- Session Block
- Template Management

## Preferences menus

The following screens loaded with no visible rows or with account-limited data:

- Manage User
- NAT Mode Setting
- Personal Information Task History
- Security Pledge
- Server and network report
- Setting Change History
- System Environment Setting
- User Security Policy
- User Task History

The following screens exposed structure or data:

- Critical Value Setting
- Limit Policy by User
- Manage Equipment
- Manage License
- Management Code
- Notification Setting
- OTP Authentication
- Operation Environment Setting
- Set Personal Information Management
- System Engine Setting
- System Operation History
- System Registration
- System Resource Use History
- User Access History
- User Management Policy
- User Menu Permission
- User Role
- User Status Change History

## Approval menus

The following screens loaded with no visible rows:

- Connect to approval automatically
- In-tray
- Manage Approval Delegation
- Manage Report Permission
- Out-tray
- Post-Approval Box
- Pre-Approval Box
- Reference Box
- Report Box
- Storage Box

The following screens exposed structure or data:

- Integrated management box
- Manage Approval Line
- Manage Approval Policy
- Manage Report Page
- Request Approval
- Urgent Approval Item Box

## Operational model learned

- HIWARE separates the registered system/engine from managed target equipment.
  An active engine entry does not prove that privileged target servers are
  enrolled.
- Device-group counts do not prove that the corresponding device rows are
  visible or configured.
- Google OTP is user-enrolled. The observed account could not establish OTP
  readiness for other users.
- Device-specific two-factor authentication menus and policy structures can
  exist while no target equipment is available for validation.
- Real-time session counters and access-history screens must be interpreted
  independently. A zero active-session count does not prove historical
  inactivity.
- Approval inboxes may be empty while approval policies and line definitions
  still exist.
- Automatic approval policies can be present but disabled.
- Notification events and delivery-channel recipients are separate settings.
  Configured event types do not prove that SMS, email, notice, or messenger
  recipients exist.
- Default scripts and command-control templates can exist without an applied
  command restriction set.
- Console values can differ from older policy documents. Session timeout,
  concurrent access, role inventory, and OTP status require current,
  scope-aware evidence.

## Evidence interpretation rules

1. Treat missing, empty, stale, permission-limited, and unverified values as
   unknown rather than healthy.
2. Distinguish engine registration, managed equipment, access permission, and
   OTP enforcement; none implies the others.
3. Do not infer an equipment count from a navigation-tree badge alone.
4. Do not infer organization-wide user or OTP status from a self-scoped user
   view.
5. Do not inspect or persist password, OTP seed, license key, session token, or
   private account material.
6. A configuration change is successful only after an independent read-back
   proves the intended state.

## Safe follow-up checklist

- Obtain the customer-approved equipment inventory: name, address, operating
  system, protocol/port, and account ownership.
- Register only approved equipment.
- Map approved users and roles to the equipment.
- Configure Google OTP two-factor authentication at the equipment scope.
- Run a user-completed OTP enrollment flow without collecting the OTP seed.
- Validate privileged access, command restriction, session recording, and
  approval flow with a test account.
- Confirm access-history and session evidence after the approved test.
- Reconcile console values against the current policy baseline and record any
  discrepancy as a finding, not as an automatic correction.
