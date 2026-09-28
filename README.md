# Kiwanis Projects — Admin/Client Real-Time Tracker

This is a **separate site** from 43 Munn, running the exact same
codebase (Admin Panel, Trades, Budget vs Actual, multi-project
Switcher, Firebase Auth admin/client split — see the full feature
list in 43 Munn's own README, since the app itself is identical).
It's meant to hold your Kiwanis Community Homes properties: 138
Paling, 97 Garside, 53 Fraser.

## How this relates to 43 Munn

- **Same Firebase project** (`munn-schedule`) — so your existing admin
  login accounts (Firebase console → Authentication → Users) work here
  too, with no extra setup.
- **Fully separate data** — every project's schedule/trades/budget
  lives under its own `projects/{projectId}/` key, isolated exactly
  like it already is between 43 Munn and any other project.
- **Fully separate project list** — this site's Project Switcher and
  Admin Panel → Projects tab only ever show Kiwanis's own projects,
  never 43 Munn's, because this repo's `data.js` sets a different
  `REGISTRY_KEY` (`project_registry_kiwanis` vs. 43 Munn's
  `project_registry`). You'll never see "43 Munn" in this site's
  dropdown, or "138 Paling" in 43 Munn's.

## Setting this up

1. **Deploy these 5 files** (`index.html`, `script.js`, `style.css`,
   `data.js`, `firebase-config.js`) to this repo's `main` branch, same
   as any GitHub Pages deploy — see 43 Munn's README section 10 if
   you need the walkthrough.
2. **Publish the security rules** — same Firebase project, so this is
   a **shared rules document** with 43 Munn. Use the
   `firebase-database-rules.json` in this delivery (it includes both
   `project_registry` and `project_registry_kiwanis`) and publish it
   in Firebase console → Realtime Database → Rules. If 43 Munn's site
   already has these exact rules published, you don't need to do this
   again.
3. **Log in** with the same admin account you use on 43 Munn — it's
   the same Firebase project, so the same account works.
4. **Add the other two properties**: Admin Panel → Projects → **+
   Create New Project** → create "97 Garside" and "53 Fraser". No code
   editing, no new repo — exactly like adding a project on 43 Munn.
5. **Build each property's schedule**: this repo's `data.js` ships
   138 Paling with an *empty* milestone list on purpose (see the note
   in that file) — the old Kiwanis schedule (71/60 independently-dated
   tasks, no dependency engine) doesn't translate cleanly into this
   app's dependency/business-day model, so nothing was auto-migrated.
   Build fresh from Admin Panel → Milestones → **+ Add Milestone**, or
   use **Import Excel / CSV** to bulk-load a schedule. If you want
   help turning the old Kiwanis schedule into an importable CSV, ask
   and I'll do that conversion.

## Everything else

Works exactly like 43 Munn — same Admin Panel, same Trade Costs /
Site Rentals / Budget vs Actual, same Gantt, same Gallery, same
CSV import/export. If you want to check anything about how a feature
works, 43 Munn's README documents the whole app in depth; nothing here
is Kiwanis-specific except the two lines in `data.js` noted above.
