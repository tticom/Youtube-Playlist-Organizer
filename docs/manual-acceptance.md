# Manual acceptance procedure

This procedure separates read-only checks from the first live write. Unattended sorting is disabled by default. Do not proceed to a write unless the user explicitly authorizes that stage. The completeness gate must remain fail-closed: pagination termination alone is never sufficient evidence.

## Install and configure

1. In the repository root run `npm install` and `npm run build`.
2. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select `dist/chrome`. For an existing unpacked install, click **Reload** after each build.
3. Open Watch Later at `https://www.youtube.com/playlist?list=WL` and reload the page.
4. In the extension popup select and save the desired preset. Confirm classification method is **Local rules** if you do not want AI provider requests. Configure subject priority and sorting preferences before acceptance.

## Stage A — Read-only Chrome inspection

1. Choose **Automatic on opening Watch Later** or **Scheduled unattended** as the intended operating mode, but do not enable unattended sorting yet. Save the setting. The on-open mode may display a preview; it cannot write before authorization.
2. Use **Preview only** in settings, or **Organize → Analyze & sort** on Watch Later. Do not click Apply.
3. Expand **Playlist retrieval diagnostics**. Record the InnerTube header count, rendered header count, retrieved entries, distinct reorderable entries, page count, pagination termination and outcome. Both header counts must agree and the exact total must match every distinct identified entry. An incomplete preview must not permit a write.
4. Confirm current account identity is visible in the Watch Later header. The extension authorizes against that channel link; it does not store cookies or authentication tokens.

## Stage B — Manual preview and completeness validation

1. Run **Analyze & sort** manually with the saved preset and local rules. Review the full proposed order and representative classifications.
2. Confirm manual overrides are reflected, unavailable entries remain present, and no item is duplicated or omitted.
3. Confirm both exact header counts match the retrieved and distinct reorderable entry counts, and the outcome is `verified`. If not, stop here: the extension must refuse mutation and unattended authorization.
4. Capture the original sequence and confirm the undo backup behavior in the preview workflow. Do not modify the playlist during this stage.

## Stage C — Explicitly authorized single live reorder

This stage permanently changes the user's Watch Later playlist. Stop and obtain explicit user approval immediately before clicking **Apply**. A prior request to implement automation is not approval for this live test.

After approval, apply one preview that actually requires at least one move. The extension records manual acceptance evidence only after its pre-write completeness check, backup, and verified readback all succeed. A no-op does not satisfy this prerequisite. If any check fails, stop and do not retry a possibly ambiguous write.

## Stage D — Verify readback and recovery

1. Reload Watch Later and independently confirm the complete saved order matches the preview.
2. Confirm the local undo backup records the original and verified resulting sequences.
3. If rollback is part of the approved acceptance, obtain approval for that additional playlist mutation, use **Undo last sort**, reload, and verify the exact original order. Do not use Undo if the current playlist differs from the recorded post-sort order.

## Stage E — Enable unattended sorting

1. Confirm the current saved subject and sort configuration is the same one used for the verified manual reorder.
2. Select the intended mode: **Automatic on opening Watch Later** or **Scheduled unattended**. Scheduled mode defaults to every 6 hours; supported intervals are 60 through 10,080 minutes.
3. Click **Enable unattended sorting** and accept its one-time confirmation that subsequent runs may permanently modify Watch Later without asking again.
4. Confirm the popup reports enabled status, authorized account, mode and schedule. A change to the account, subjects, approved classification rules, or sort settings invalidates authorization and requires a new accepted manual reorder.

## Stage F — Verify an unattended cycle

1. Keep Chrome running and awake. For a timely first test, select an hourly interval. Close the popup; no open Watch Later tab or user interaction is required for scheduled runs.
2. Wait for **Last successful run** or a result notification. A no-op cycle should say the playlist was already ordered and report zero reordered entries. The code skips the write entirely in this case.
3. For a changed playlist, verify the reported reorder count, reload Watch Later, and compare the saved order. Do not manually edit the list during the run.
4. Inspect **View recent results** for counts, status and errors. Confirm history contains no cookies or tokens. Pause or disable automation at any time from the popup.
5. If Chrome or the computer sleeps, scheduled work is delayed. Chrome alarms are event-driven and may run late; after a missed due time, the extension catches up at most once. It does not run while Chrome is closed.

## Failure and recovery checks

- Remove or change the visible header count, switch accounts, or cause a concurrent playlist edit only in a separately authorized disposable test. Each case must stop writes, preserve unavailable entries, retain a recoverable backup if a write was attempted, and mark attention as needed.
- Incomplete counts, duplicate or unidentified entries, account mismatch, concurrent changes, backup failure and ambiguous writes pause unattended mutation. Inspect Watch Later before resuming.
- Transient failures use bounded exponential backoff; after five failed attempts automation pauses. Ambiguous mutation results are never retried in the same run. A later run begins with a fresh complete read.
- Notifications are opt-in. If enabled, attention/failure notifications are visually distinct from success and no-op notifications. The settings status and bounded local history remain available without notifications.

## Current acceptance status

The Watch Later rendered header was observed as 22 videos during the earlier read-only inspection, but the extension's live InnerTube diagnostics were not captured. This does not establish completeness. Inactive background-tab behavior, one live reorder, scheduled unattended execution and rollback remain unverified until Stages A–F are run in Chrome. Automated tests mock all YouTube mutations and do not prove live service behavior.
