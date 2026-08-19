# Governance

Triss uses maintainer consensus for normal changes. Security-sensitive,
compatibility-breaking, and release changes require approval from a maintainer
with ownership of that area. When consensus cannot be reached, the lead
maintainer makes the decision and records the rationale in the pull request or
an architecture decision record.

Only maintainers explicitly listed in [MAINTAINERS.md](MAINTAINERS.md) may hold
GitHub environment or npm release access. Release access is least-privilege,
reviewed periodically, and removed promptly when no longer needed.

A contributor may become a maintainer after sustained, reviewable work,
demonstrated security judgment, and approval by the existing maintainers.
Emergency releases still require reproducible gates and an incident record;
urgency does not authorize bypassing artifact verification.
