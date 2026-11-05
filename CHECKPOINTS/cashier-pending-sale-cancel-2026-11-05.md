# Cashier pending-sale cancellation · 2026-11-05

Extends draft PR #2 on `feat/owner-pending-sale-cancel-2026-11-05`, starting at `281940402300925e75e5bac4ff448b3b5ee5a474`. Main comparison: `a409f37810a34b13142bc3c750694910b1f4f314`.

The user confirmed that “admin password/code” means the existing cashier approval code (`owner_approval_pin`). No new password, admin-panel unlock, login change or role grant is introduced.

## Behavior and scope

- The existing Kassa pending-sales dialog is now available to an active cashier with an assigned shop. It reads that cashier's device queue and displays only their own pending rows from the assigned shop. The protected owner's device-wide recovery remains available; an ordinary admin or manager does not gain cancellation access.
- Every cancellation, including a replay, validates the existing admin approval code on the server using its existing PBKDF2 verification and actor-based failure limit. Cashier shift ownership and assigned shop are checked from the stored User before any cancellation acknowledgment is returned. Browser role, owner, shop and user claims cannot authorize another shift.
- Keep the existing atomic Shift claim, durable cancellation journal, exact key/shift/user/shop acknowledgment and lost-response recovery. Record the stored actor ID and role in the journal. Completed, claimed, ambiguous or closing work remains protected. Unclaimed offline requests from a closed shift can be cancelled without rewriting money or inventory.
- Remove a local row only after the exact server acknowledgment. The code is transient and is never persisted with the queue, reason journal or logs.
- Re-key the dialog when identity, role, owner permission or shop changes. Clear credentials/selection and ignore stale completions. A request still waiting for the queue lock is not sent after its dialog or identity has changed.
- Add field locks for the stored User authorization fields (`role`, `shop_id`, `active`, `is_owner`) and retain the Shift claim/journal locks. Keep `write: false` and add explicit create/update editor conditions: app users cannot self-assign privileges or rewrite claims. Existing staff management continues through the authenticated service-role backend. App editors retain their platform management powers. These schema changes must ship with the backend.

## Offline verification in the clean Windows workspace

- Locked dependencies installed with `npm ci --ignore-scripts --no-audit --no-fund`.
- `npm run build`: passed. Existing missing local Base44 app/proxy configuration and large-bundle warnings remain; the build is not a configured live deployment.
- `npm run lint`: passed.
- Focused run: `node --test tests/owner-pending-sale-cancel.test.mjs tests/owner-pending-sales-dialog.test.mjs tests/owner-admin-access.test.mjs tests/security-hardening.test.mjs`: **58 passed, 0 failed**.
- Full run: `node --test tests/*.test.mjs src/tests/*.test.mjs`: **1,445 tests, 1,326 passed, 119 failed**. A clean main worktree with the same dependencies and runtime: **1,404 tests, 1,285 passed, the exact same 119 failing names**. No newly failing names. The draft adds 41 tests over main, including 17 added in this update. Counts differ from the prior environment's 108 baseline failures; this comparison was rerun locally rather than assuming the previous counts.
- `npm run typecheck` (same `tsc -p ./jsconfig.json`): **1,377 errors on both main and this branch**. Normalized diagnostic comparison found no new errors.
- `git diff --check`: passed.

Coverage includes wrong/missing/rate-limited codes, stored identity and inactive users, cross-user/cross-shop attempts, forged browser/auth fields, replay after reassignment, completed/claimed/closing work, both claim race outcomes, lost writes, exact acknowledgment binding, cashier-only device queue, same-ID role/shop changes, stale responses and queued requests after an identity change. All business data and APIs were mocked/in-memory; no live backend was invoked.

## Publication boundary

This remains a draft. No merge, Base44 publish/deploy, live sale cancellation, payment/stock change, credential access or PIN change was performed. Before publication, verify the User and Shift field rules and service-role writes in an authorized isolated staging app and publish the backend, schemas and UI together. Offline schema assertions cannot prove hosted enforcement. See [Base44 security](https://docs.base44.com/developers/backend/resources/entities/security) and the [field-rule reference](https://docs.base44.com/developers/skills/base44-cli/references/entities-create#field-level-security-fls).
