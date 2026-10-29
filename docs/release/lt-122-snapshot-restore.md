# Validated HTML snapshot recovery (LT-122)

HTML history contains only complete, valid `.json` metadata plus same-basename
`.html` pairs. Tag snapshots (`.tags.json`) remain available to the separate tag
restore interface; they never enter HTML recovery. Default selection skips
malformed, missing, corrupt or wrong-target entries and selects the newest valid
HTML pair matching the canonical host, page ID and page path. A pinned timestamp
or explicit path fails closed if no matching valid pair exists; it never falls
back to another snapshot.

Core `revertPage(..., {snapshotPath})` accepts either `.json` or `.html`.
Paths must name a direct file in the configured `REMEDY_SNAPSHOT_DIR/<pageId>`
directory. External paths, `..` components, root/page symlinks, file symlinks and
nonregular files are rejected. The configured root's ancestors are trusted local
configuration (macOS `/var` may resolve through `/private/var`); protect the whole
storage tree from untrusted local writers and concurrent directory replacement.
Final files use POSIX `O_NOFOLLOW` while opening; supported signed deployments
already require POSIX. Snapshots are never deleted by selection or validation.

Existing metadata needs no migration: the timestamp/hash basename, page directory,
required metadata types, exact UTF-8 byte count and truncated SHA-256 content hash
must agree. This detects corruption, not deliberate replacement by a local actor
who can rewrite both files. Renamed/moved targets require new matching recovery
evidence. Listings and restores revalidate the pair rather than trusting previously
loaded metadata.

Restore previews retain the selected timestamp and exact output in the unchanged
signed binding. Dispatch reselects and validates that timestamp/target/output;
missing or changed evidence cannot authorize another snapshot. The current live
HTML is saved as the pre-restore rollback pair before dispatch and referenced in
the durable claim; audit records reference the selected historical metadata file.
No live CXone write or sandbox canary is part of this validation. General request
bounds, outside-editor conditional writes, cross-stack tests and deployment gates
remain tracked by LT-113/LT-111.
