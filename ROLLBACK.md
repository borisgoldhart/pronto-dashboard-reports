# Rolling back

Two independent ways to undo a release. The first takes seconds and needs no code;
the second is the one to use if you want the repository itself to go back.

## 1. Fastest: put the previous build back live (Vercel)

Vercel keeps every past deployment permanently. Putting one back live does **not**
rebuild anything — it re-points the production domain at a build that already exists,
which is why it takes seconds and cannot fail halfway.

1. Open the project in Vercel → **Deployments**.
2. Find the last deployment you were happy with. Every row shows its commit message,
   so look for the one you want (before the dual-source work: _"Frozen snapshots:
   share links whose numbers can't drift or go blank"_).
3. Open its **⋯** menu → **Promote to Production** (on the current production
   deployment the same action appears as **Instant Rollback**).

The live site is back within seconds. Nothing in GitHub changes, so whatever is on
`main` will go live again on the next push — do step 2 as well if you want the
rollback to stick.

## 2. Putting the code back

Every release is tagged, so there is always a named point to return to.

| Tag | What it is |
| --- | --- |
| `demo-safe` | Frozen snapshots. The build demonstrated and verified live on 29 Jul 2026. |
| `v2-dual-source` | Adds the second data source overlay and moves the Office picker to the top of the graph settings. |

To undo the dual-source release and redeploy the previous one:

```bash
git revert --no-edit v2-dual-source~1..v2-dual-source   # undo, keeping the history
git push origin main                                    # Vercel rebuilds automatically
```

`revert` is deliberate here rather than `reset --hard`: it adds a new commit that
undoes the change, so nothing is lost and the work can be reinstated later with
`git revert` on the revert. Never force-push `main` — that would destroy the record
Vercel uses to tell its deployments apart.

To look at (rather than restore) exactly what was live at a tag:

```bash
git checkout demo-safe          # detached HEAD, look around
git checkout main               # back to normal
```

## 3. If only one widget misbehaves

The dual-source overlay is opt-in per widget and stored in that widget's spec. If a
single chart is wrong, open it, set **Second data source** back to _None_, and hit
Apply, then Save dashboard. No deploy needed, and every other widget is untouched.

## What a rollback does NOT affect

- **Saved dashboards and frozen snapshots.** These live in Redis, not in the code.
  Rolling the code back leaves them exactly as they are.
- **A dashboard saved with an overlay while the new code was live.** The old code
  ignores the `overlay` block in a widget spec rather than failing on it, so the
  widget reappears as a normal bar chart. Nothing needs cleaning up.
- **Environment variables.** Those are set in Vercel and are not part of a deploy.
