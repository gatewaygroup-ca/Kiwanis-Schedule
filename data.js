/* ============================================================
   PROJECT DATA / BASELINE CONFIGURATION — KIWANIS PROJECTS SITE
   ------------------------------------------------------------
   This is a SEPARATE deployment of the same codebase as 43 Munn,
   sharing the same Firebase project ("munn-schedule") but keeping
   its own project list via REGISTRY_KEY below, so this site's
   Project Switcher / Admin > Projects never shows 43 Munn (or vice
   versa) even though the data technically lives in the same
   Firebase project, isolated by path.

   PROJECT_ID is this repo's own baked-in default project — 138
   Paling. The other two Kiwanis properties (97 Garside, 53 Fraser)
   are NOT defined here: create them from Admin Panel > Projects >
   + Create New Project once this is deployed and you're logged in.
   No code editing needed for those two.
   ============================================================ */

const PROJECT_ID = "138-paling";

// Distinct from 43 Munn's "project_registry" key -- this is what keeps
// the two sites' Project Switchers from showing each other's projects,
// even though both talk to the same underlying Firebase project.
const REGISTRY_KEY = "project_registry_kiwanis";

const DEFAULT_SETTINGS = {
  title: "138 Paling",
  address: "138 Paling Ave, Hamilton, ON",
  clientName: "Kiwanis",
  projectType: "Residential Construction",
  description: "",
  start: "2026-10-01",
  targetCompletion: "2027-06-01",
  status: "Not Started",
  companyName: "Gateway Group",
  companyLogoDataUrl: null,
  subtitle: "Project milestone schedule & live tracker",
  projectManager: "",
  operationsCoordinator: "",
  contact: "",
  footerText: "",
  showFinancialsToClients: false,
  actualExpenseBasis: "Invoice",
};

const DEFAULT_HOLIDAYS = [
  { date: "2026-10-12", name: "Thanksgiving Day" },
  { date: "2026-12-25", name: "Christmas Day" },
  { date: "2026-12-26", name: "Boxing Day" },
  { date: "2027-01-01", name: "New Year's Day" },
  { date: "2027-02-15", name: "Family Day" },
  { date: "2027-04-02", name: "Good Friday" },
];

// Intentionally empty: the old Kiwanis schedule (71/60-task lists with
// no dependency engine) doesn't map cleanly onto this app's
// dependency/business-day model, so nothing was auto-migrated -- that
// would risk silently getting the sequencing wrong. Build 138 Paling's
// schedule fresh from the Admin Panel (Milestones tab > + Add
// Milestone), or use "Import Excel / CSV" if you want to bulk-load it
// from a spreadsheet. Ask if you'd like help turning the old data into
// an importable CSV.
const BASELINE_MILESTONES = [];

const BASELINE_TRADES = [];
