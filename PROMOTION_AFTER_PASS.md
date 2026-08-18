# Promotion after acceptance

Do not manually enable formal trading from this Candidate.

After the acceptance regression passes, promote a separate formal package named `TENCENT_MINUTE_V1.0`. The formal package should preserve the tested parsing/aggregation code and only change release-state gating/metadata needed for production use. This keeps an auditable distinction between the tested Candidate and the approved production build.
