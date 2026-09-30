/* ============================================================
/* ============================================================
   PROJECT SCHEDULE ENGINE + APP
   (project-specific values come from PROJECT_ID + DEFAULT_SETTINGS
   in data.js as an initial seed; live values come from Firebase
   at projects/{PROJECT_ID}/settings)
   ============================================================ */

/* ---------- Multi-project switching ----------
   CURRENT_PROJECT_ID starts as the PROJECT_ID baked into this repo's
   data.js (so a fresh deploy behaves exactly as before), but can change
   at runtime via the Project Switcher / Admin > Projects, which detaches
   the old Firebase listeners and re-attaches under the new project's
   projects/{id}/ path. A single-project deploy that never touches the
   switcher behaves exactly as before. ---------- */
let CURRENT_PROJECT_ID = PROJECT_ID;

// Which top-level Firebase node holds this SITE's project list. Separate
// deployments that share one Firebase project (e.g. 43 Munn and a
// Kiwanis Projects site both living under the "munn-schedule" Firebase
// project) each get their own registry key -- set via REGISTRY_KEY in
// that repo's data.js -- so their Project Switchers never show each
// other's projects. Falls back to "project_registry" (this repo's
// original key) when data.js doesn't define one, so existing deploys
// are unaffected.
const PROJECT_REGISTRY_KEY = (typeof REGISTRY_KEY !== "undefined" && REGISTRY_KEY) ? REGISTRY_KEY : "project_registry";

// Remembers which project was last selected on THIS site (namespaced by
// PROJECT_REGISTRY_KEY so 43 Munn and Kiwanis, sharing a browser, don't
// clobber each other's "last project"). Without this, switching to a
// project in the dropdown only lasted until the next page load/refresh --
// the app would silently fall back to this repo's baked-in default
// project, making saved edits on any other project look like they
// vanished (they didn't -- you were just looking at a different project).
const LAST_PROJECT_STORAGE_KEY = "lastProjectId_" + PROJECT_REGISTRY_KEY;
try {
  const savedProjectId = localStorage.getItem(LAST_PROJECT_STORAGE_KEY);
  if (savedProjectId) CURRENT_PROJECT_ID = savedProjectId;
} catch (e) { /* localStorage unavailable (e.g. private browsing) -- fall back to default project */ }

/* ---------- Project settings (mirrors STATE.settings for minimal
   downstream changes -- existing code reads PROJECT.address etc.
   unchanged) ---------- */
let PROJECT = Object.assign({}, DEFAULT_SETTINGS, { id: CURRENT_PROJECT_ID });

/* ---------- Role / auth state ----------
   USER_ROLE is UI-only. It does NOT grant write access by itself --
   actual write permission is enforced by Firebase Security Rules
   (see firebase-database-rules.json). Any signed-in Firebase Auth
   user is treated as admin; everyone else is a read-only client. */
let USER_ROLE = "client";
let CURRENT_USER = null;

/* ---------- Global mutable state ---------- */
const STATE = {
  settings: deepClone(DEFAULT_SETTINGS),
  milestones: deepClone(BASELINE_MILESTONES),
  trades: deepClone(BASELINE_TRADES),
  budgetCategories: [],
  holidays: deepClone(DEFAULT_HOLIDAYS),
  activity: [],
  lastUpdated: new Date(),
  statusFilter: "All",
  tradeFilter: "active",
  activityPage: 1,
  openMilestoneId: null,
  openTradeId: null,
  openBudgetCategoryId: null,
  galleryLightbox: { milestoneId: null, index: 0 },
};

const ACTIVITY_PAGE_SIZE = 5;
const WORK_STATUS_OPTIONS = ["Not Started", "In Progress", "Complete", "On Hold"];

const STATUS_OPTIONS = ["Not Started", "In Progress", "Complete", "Delayed", "On Hold"];
const STATUS_COLOR = {
  "Not Started": "gray",
  "In Progress": "blue",
  "Complete": "green",
  "Delayed": "red",
  "On Hold": "amber",
};
const PRIORITY_OPTIONS = ["Low", "Normal", "High"];

function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }
function pad(n) { return n < 10 ? "0" + n : "" + n; }
function isoDate(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
function parseISO(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
function fmtDate(d) { return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); }
function fmtDateShort(d) { return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }); }

/* ============================================================
   BUSINESS-DAY ENGINE
   ============================================================ */

function isWeekend(d) { const day = d.getDay(); return day === 0 || day === 6; }

function isHoliday(d, holidays) {
  const s = isoDate(d);
  return holidays.some(h => h.date === s);
}

function isBusinessDay(d, holidays) {
  return !isWeekend(d) && !isHoliday(d, holidays);
}

function nextBusinessDay(d, holidays) {
  const cur = new Date(d);
  cur.setDate(cur.getDate() + 1);
  while (!isBusinessDay(cur, holidays)) cur.setDate(cur.getDate() + 1);
  return cur;
}

// Returns {start, finish} — start is rolled forward to the first
// business day on/after the given date; finish is `duration`
// business days later inclusive of start.
function addBusinessDays(fromDate, duration, holidays) {
  const start = new Date(fromDate);
  while (!isBusinessDay(start, holidays)) start.setDate(start.getDate() + 1);
  let count = 1;
  const cursor = new Date(start);
  const dur = Math.max(1, duration);
  while (count < dur) {
    cursor.setDate(cursor.getDate() + 1);
    if (isBusinessDay(cursor, holidays)) count++;
  }
  return { start, finish: cursor };
}

// Signed count of business days between two dates (end - start),
// excluding weekends/holidays. Positive = end is after start.
function calculateBusinessDays(startDate, endDate, holidays) {
  if (isoDate(startDate) === isoDate(endDate)) return 0;
  const forward = endDate > startDate;
  let a = new Date(Math.min(startDate, endDate));
  const b = new Date(Math.max(startDate, endDate));
  let count = 0;
  const cur = new Date(a);
  while (cur < b) {
    cur.setDate(cur.getDate() + 1);
    if (isBusinessDay(cur, STATE.holidays)) count++;
  }
  return forward ? count : -count;
}

/* ============================================================
   SCHEDULE COMPUTATION (dependency resolution)
   ============================================================ */

function computeSchedule(milestones, holidays, projectStartISO) {
  const projectStart = parseISO(projectStartISO);
  const resolved = {};
  const results = {};
  let iterations = 0;
  const maxIter = milestones.length + 5;

  while (Object.keys(resolved).length < milestones.length && iterations < maxIter) {
    iterations++;
    for (const m of milestones) {
      if (resolved[m.id]) continue;
      const deps = m.dependency || [];
      const ready = deps.every(depId => resolved[depId]);
      if (!ready) continue;

      let fromDate;
      if (m.manualStart) {
        fromDate = parseISO(m.manualStart);
      } else if (deps.length === 0) {
        fromDate = projectStart;
      } else {
        const depFinishes = deps.map(depId => results[depId].finish);
        const maxFinish = new Date(Math.max(...depFinishes.map(d => d.getTime())));
        fromDate = nextBusinessDay(maxFinish, holidays);
      }
      const { start, finish } = addBusinessDays(fromDate, m.duration, holidays);
      results[m.id] = { start, finish };
      resolved[m.id] = true;
    }
  }

  if (Object.keys(resolved).length < milestones.length) {
    milestones.forEach(m => {
      if (!resolved[m.id]) console.error(`Circular or broken dependency at milestone #${m.id} (${m.name})`);
    });
  }
  return results;
}

/* ============================================================
   DERIVED METRICS
   ============================================================ */

function getComputed() {
  return computeSchedule(STATE.milestones, STATE.holidays, PROJECT.start);
}

function getProjectedCompletion(schedule) {
  let latest = null;
  STATE.milestones.forEach(m => {
    const f = schedule[m.id] && schedule[m.id].finish;
    if (f && (!latest || f > latest)) latest = f;
  });
  return latest;
}

function getOverallProgress() {
  const totalDur = STATE.milestones.reduce((s, m) => s + m.duration, 0);
  const weighted = STATE.milestones.reduce((s, m) => s + m.duration * m.progress, 0);
  return totalDur ? Math.round(weighted / totalDur) : 0;
}

function getCounts() {
  const c = { "Not Started": 0, "In Progress": 0, "Complete": 0, "Delayed": 0, "On Hold": 0 };
  STATE.milestones.forEach(m => c[m.status] = (c[m.status] || 0) + 1);
  return c;
}

function getScheduleHealth(varianceDays, counts) {
  const delayed = counts["Delayed"] || 0;
  let level, label, icon;
  if (varianceDays > 10 || delayed >= 2) { level = "red"; label = "DELAYED"; icon = "\uD83D\uDD34"; }
  else if (varianceDays > 0 || delayed === 1) { level = "amber"; label = "AT RISK"; icon = "\uD83D\uDFE1"; }
  else { level = "green"; label = "ON TRACK"; icon = "\uD83D\uDFE2"; }

  let explanation;
  if (delayed > 0) {
    const worst = STATE.milestones.filter(m => m.status === "Delayed")[0];
    explanation = `Project is currently ${Math.abs(varianceDays)} business day${Math.abs(varianceDays) === 1 ? "" : "s"} ${varianceDays >= 0 ? "behind" : "ahead of"} target, with ${delayed} milestone${delayed === 1 ? "" : "s"} marked delayed (e.g. ${worst.name}).`;
  } else if (varianceDays > 0) {
    explanation = `Projected completion is ${varianceDays} business day${varianceDays === 1 ? "" : "s"} past the target completion date.`;
  } else if (varianceDays < 0) {
    explanation = `Projected completion is ${Math.abs(varianceDays)} business day${Math.abs(varianceDays) === 1 ? "" : "s"} ahead of the target completion date.`;
  } else {
    explanation = `Projected completion lands exactly on the target completion date.`;
  }
  return { level, label, icon, explanation };
}

// A single 0-100 number summarizing schedule health, so it can be shown
// as one glance-able figure on the dashboard (alongside the existing
// green/amber/red label, which stays exactly as-is). Starts at 100 and
// loses points for schedule variance and for delayed/on-hold milestones;
// never goes below 0 or above 100.
function getOnTrackScore(varianceDays, counts) {
  let score = 100;
  if (varianceDays > 0) score -= Math.min(50, varianceDays * 2.5);
  else if (varianceDays < 0) score += Math.min(5, Math.abs(varianceDays) * 0.2); // small credit for running ahead, capped
  score -= (counts["Delayed"] || 0) * 12;
  score -= (counts["On Hold"] || 0) * 6;
  return Math.max(0, Math.min(100, Math.round(score)));
}

/* ============================================================
   LIVE SYNC (Firebase Realtime Database)
   Every mutation writes the whole schedule to /schedule.
   Every client listens to /schedule and re-renders on any
   change — including its own writes and writes from other
   tabs/devices. Last write wins.
   ============================================================ */

let FIREBASE_READY = false;

// Firebase Realtime Database silently drops empty arrays ([]) and null
// fields on write — they simply won't exist when read back, leaving the
// JS object with `undefined` for that key instead of [] or null. That
// undefined then blows up code expecting an array, and if it gets written
// back verbatim, Firebase's .set() throws and aborts the ENTIRE save
// (nothing else in that write goes through either). These two helpers
// keep milestone objects well-formed on the way out and on the way in.
function sanitizeMilestone(m) {
  return {
    id: m.id,
    name: m.name,
    description: m.description || "",
    order: Number.isFinite(m.order) ? m.order : 0,
    duration: m.duration,
    dependency: Array.isArray(m.dependency) ? m.dependency : [],
    manualStart: (m.manualStart === undefined || m.manualStart === null) ? null : m.manualStart,
    status: m.status,
    progress: m.progress,
    trade: m.trade || "",
    priority: m.priority || "Normal",
    notes: m.notes || "",
    contractPrice: Number(m.contractPrice) || 0,
    changeOrders: (Array.isArray(m.changeOrders) ? m.changeOrders : []).map(sanitizeChangeOrder),
    invoices: (Array.isArray(m.invoices) ? m.invoices : []).map(sanitizeInvoice),
    paymentDetails: sanitizePaymentDetails(m.paymentDetails),
    gallery: sanitizeGallery(m.gallery),
  };
}
function sanitizeGallery(gallery) {
  return (Array.isArray(gallery) ? gallery : []).map(p => ({
    id: p.id,
    dataUrl: p.dataUrl || "",
    thumbDataUrl: p.thumbDataUrl || p.dataUrl || "",
    fileName: p.fileName || "",
    caption: p.caption || "",
    date: p.date || null,
    uploadedAt: p.uploadedAt || new Date().toISOString(),
    uploadedBy: p.uploadedBy || "Admin",
  }));
}
function sanitizeChangeOrder(c) {
  return {
    id: c.id,
    description: c.description || "",
    date: c.date || null,
    amount: Number(c.amount) || 0,
    approvedBy: c.approvedBy || "",
    status: c.status || "Pending",
    notes: c.notes || "",
  };
}
function sanitizeInvoice(inv) {
  return {
    id: inv.id,
    invoiceNumber: inv.invoiceNumber || "",
    vendor: inv.vendor || "",
    invoiceDate: inv.invoiceDate || null,
    dueDate: inv.dueDate || null,
    subtotal: Number(inv.subtotal) || 0,
    hst: Number(inv.hst) || 0,
    total: Number(inv.total) || 0,
    paymentStatus: inv.paymentStatus || "Pending",
    paymentDate: inv.paymentDate || null,
    fileName: inv.fileName || "",
    notes: inv.notes || "",
  };
}
function sanitizePaymentDetails(pd) {
  pd = pd || {};
  return {
    vendorName: pd.vendorName || "",
    poNumber: pd.poNumber || "",
    paymentTerms: pd.paymentTerms || "",
    paymentMethod: pd.paymentMethod || "",
    bankName: pd.bankName || "",
    accountName: pd.accountName || "",
    accountLast4: pd.accountLast4 || "",
    paymentReference: pd.paymentReference || "",
    notes: pd.notes || "",
  };
}
function rehydrateMilestone(m) {
  return {
    ...m,
    description: m.description || "",
    order: Number.isFinite(m.order) ? m.order : 0, // 0 = "no order yet"; migrateMilestoneOrder() assigns real values
    dependency: Array.isArray(m.dependency) ? m.dependency : [],
    manualStart: m.manualStart === undefined ? null : m.manualStart,
    trade: m.trade || "",
    priority: m.priority || "Normal",
    notes: m.notes || "",
    contractPrice: Number(m.contractPrice) || 0,
    changeOrders: Array.isArray(m.changeOrders) ? m.changeOrders.map(sanitizeChangeOrder) : [],
    invoices: Array.isArray(m.invoices) ? m.invoices.map(sanitizeInvoice) : [],
    paymentDetails: sanitizePaymentDetails(m.paymentDetails),
    gallery: sanitizeGallery(m.gallery), // safe default [] for pre-existing milestones with no gallery yet
  };
}

function sanitizeTradeChangeOrder(c) {
  return {
    changeOrderId: c.changeOrderId,
    description: c.description || "",
    date: c.date || null,
    amount: Number(c.amount) || 0,
    approvedBy: c.approvedBy || "",
    status: c.status || "Pending",
    notes: c.notes || "",
  };
}
function sanitizeTradeInvoice(inv) {
  return {
    invoiceId: inv.invoiceId,
    invoiceNumber: inv.invoiceNumber || "",
    vendor: inv.vendor || "",
    invoiceDate: inv.invoiceDate || null,
    dueDate: inv.dueDate || null,
    subtotal: Number(inv.subtotal) || 0,
    hst: Number(inv.hst) || 0,
    total: Number(inv.total) || 0,
    fileName: inv.fileName || "",
    notes: inv.notes || "",
  };
}
function sanitizeTradePayment(p) {
  return {
    paymentId: p.paymentId,
    invoiceId: (p.invoiceId === undefined || p.invoiceId === null) ? null : p.invoiceId,
    amount: Number(p.amount) || 0,
    date: p.date || null,
    method: p.method || "",
    reference: p.reference || "",
    notes: p.notes || "",
  };
}
function normalizeMilestoneIds(t) {
  if (Array.isArray(t.milestoneIds)) return t.milestoneIds.filter(id => id !== null && id !== undefined);
  if (t.milestoneId !== undefined && t.milestoneId !== null) return [t.milestoneId]; // legacy single-link migration
  return [];
}

function sanitizeTrade(t) {
  return {
    tradeId: t.tradeId,
    tradeName: t.tradeName || "",
    vendor: t.vendor || "",
    scope: t.scope || "",
    category: t.category || "Trade", // "Trade" | "Site Rentals" | "Other" -- drives which table it shows in
    milestoneIds: normalizeMilestoneIds(t),
    contractAmount: Number(t.contractAmount) || 0,
    hst: Number(t.hst) || 0,
    workStatus: t.workStatus || "Not Started",
    paymentTerms: t.paymentTerms || "",
    poNumber: t.poNumber || "",
    notes: t.notes || "",
    active: t.active === undefined ? true : !!t.active,
    createdAt: t.createdAt || new Date().toISOString(),
    updatedAt: t.updatedAt || new Date().toISOString(),
    changeOrders: (Array.isArray(t.changeOrders) ? t.changeOrders : []).map(sanitizeTradeChangeOrder),
    invoices: (Array.isArray(t.invoices) ? t.invoices : []).map(sanitizeTradeInvoice),
    payments: (Array.isArray(t.payments) ? t.payments : []).map(sanitizeTradePayment),
  };
}
function rehydrateTrade(t) {
  const rest = { ...t };
  delete rest.milestoneId; // fully replaced by milestoneIds
  return {
    ...rest,
    milestoneIds: normalizeMilestoneIds(t),
    vendor: t.vendor || "",
    scope: t.scope || "",
    category: t.category || "Trade",
    paymentTerms: t.paymentTerms || "",
    poNumber: t.poNumber || "",
    notes: t.notes || "",
    active: t.active === undefined ? true : !!t.active,
    changeOrders: Array.isArray(t.changeOrders) ? t.changeOrders.map(sanitizeTradeChangeOrder) : [],
    invoices: Array.isArray(t.invoices) ? t.invoices.map(sanitizeTradeInvoice) : [],
    payments: Array.isArray(t.payments) ? t.payments.map(sanitizeTradePayment) : [],
  };
}

function firebaseSave() {
  if (typeof db === "undefined") return;
  if (USER_ROLE !== "admin") return; // client-side guard; real enforcement is Firebase rules
  const payload = {
    milestones: STATE.milestones.map(sanitizeMilestone),
    trades: STATE.trades.map(sanitizeTrade),
    budgetCategories: (STATE.budgetCategories || []).map(sanitizeBudgetCategory),
    holidays: STATE.holidays,
    activity: STATE.activity.map(a => ({ text: a.text, time: a.time.toISOString() })),
    lastUpdated: STATE.lastUpdated.toISOString(),
  };
  db.ref(`projects/${CURRENT_PROJECT_ID}/schedule`).set(payload).catch((err) => {
    console.error("Firebase save failed:", err);
    showSaveError(err);
  });
}

function firebaseSaveSettings() {
  if (typeof db === "undefined") return;
  if (USER_ROLE !== "admin") return;
  return db.ref(`projects/${CURRENT_PROJECT_ID}/settings`).set(STATE.settings).catch((err) => {
    console.error("Firebase settings save failed:", err);
    showSaveError(err);
    throw err;
  });
}

function showSaveError(err) {
  const msg = (err && err.code === "PERMISSION_DENIED")
    ? "You're not signed in as an admin, so this change wasn't saved. Log in via the Admin button and try again."
    : "Couldn't sync to the live database: " + (err && err.message ? err.message : err) + "\n\nYour change is only visible in this browser until this is fixed.";
  alert(msg);
}

/* ============================================================
   MULTI-PROJECT PLATFORM
   ------------------------------------------------------------
   Project isolation was already real (projects/{PROJECT_ID}/...).
   What's added here is a registry so the app can list, create,
   edit, archive/restore, and duplicate projects from the browser,
   plus a switcher that repoints the live listeners at a different
   project's data without reloading the page.
   ============================================================ */

// { [projectId]: { name, address, projectNumber, client, projectType,
//   startDate, targetCompletion, status, projectManager, description,
//   coverImageDataUrl, notes, archived, order, createdAt } }
let PROJECT_REGISTRY = {};
let SETTINGS_REF = null;
let SCHEDULE_REF = null;
let REGISTRY_REF = null;

function slugify(s) {
  return (s || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "project";
}

function uniqueProjectId(base) {
  let id = slugify(base);
  let n = 2;
  while (PROJECT_REGISTRY[id]) { id = slugify(base) + "-" + n; n++; }
  return id;
}

function nextRegistryOrder() {
  const orders = Object.values(PROJECT_REGISTRY).map(p => Number.isFinite(p.order) ? p.order : 0);
  return orders.length ? Math.max(...orders) + 1 : 1;
}

// Detaches the currently-attached settings/schedule listeners (if any),
// so switching projects doesn't leave a stale listener writing the OLD
// project's STATE out from under the NEW one.
function firebaseUnlistenSchedule() {
  if (SETTINGS_REF) { SETTINGS_REF.off(); SETTINGS_REF = null; }
  if (SCHEDULE_REF) { SCHEDULE_REF.off(); SCHEDULE_REF = null; }
}

// Bootstrap: this repo's own PROJECT_ID always exists functionally (it
// has settings/schedule already), so make sure it also shows up in the
// registry once an admin is signed in, without ever touching its live
// schedule/settings data. Safe to call repeatedly -- no-ops once the
// entry exists. Called both when the registry first loads AND whenever
// auth state changes (login can happen well after the registry's first,
// signed-out fire, which is the normal case on every page load).
function ensureCurrentProjectInRegistry() {
  if (typeof db === "undefined") return;
  if (USER_ROLE !== "admin") return;
  if (PROJECT_REGISTRY[PROJECT_ID]) return;
  const entry = {
    name: PROJECT.title || PROJECT.address || PROJECT_ID,
    address: PROJECT.address || "",
    projectNumber: "",
    client: PROJECT.clientName || "",
    projectType: PROJECT.projectType || "",
    startDate: PROJECT.start || "",
    targetCompletion: PROJECT.targetCompletion || "",
    status: PROJECT.status || "In Progress",
    projectManager: PROJECT.projectManager || "",
    description: PROJECT.description || "",
    coverImageDataUrl: null,
    notes: "",
    archived: false,
    order: nextRegistryOrder(),
    createdAt: new Date().toISOString(),
  };
  db.ref(PROJECT_REGISTRY_KEY + "/" + PROJECT_ID).set(entry).catch(() => {});
  PROJECT_REGISTRY[PROJECT_ID] = entry; // optimistic, avoids a blank switcher until the write round-trips
  renderProjectSwitcher();
}

function listenProjectRegistry() {
  if (typeof db === "undefined") return;
  REGISTRY_REF = db.ref(PROJECT_REGISTRY_KEY);
  REGISTRY_REF.on("value", (snapshot) => {
    const val = snapshot.val() || {};
    PROJECT_REGISTRY = val;
    ensureCurrentProjectInRegistry();
    renderProjectSwitcher();
    if (document.getElementById("adminPanelOverlay").classList.contains("show") && ADMIN_PANEL_TAB === "projects") {
      renderAdminProjectsTab();
    }
  }, (err) => console.error("Project registry listen failed:", err));
}

function registryList(includeArchived) {
  return Object.keys(PROJECT_REGISTRY)
    .map(id => Object.assign({ id }, PROJECT_REGISTRY[id]))
    .filter(p => includeArchived || !p.archived)
    .sort((a, b) => (a.order || 0) - (b.order || 0));
}

function switchProject(projectId) {
  if (!projectId || projectId === CURRENT_PROJECT_ID) return;
  if (USER_ROLE !== "admin" && !PROJECT_REGISTRY[projectId]) return; // unknown project, ignore
  closeAdminPanel();
  closeModal();
  closeTradeModal();
  firebaseUnlistenSchedule();
  CURRENT_PROJECT_ID = projectId;
  try { localStorage.setItem(LAST_PROJECT_STORAGE_KEY, projectId); } catch (e) {}
  STATE.settings = deepClone(DEFAULT_SETTINGS);
  STATE.milestones = [];
  STATE.trades = [];
  STATE.budgetCategories = [];
  STATE.holidays = deepClone(DEFAULT_HOLIDAYS);
  STATE.activity = [];
  STATE.statusFilter = "All";
  STATE.tradeFilter = "active";
  FIREBASE_READY = false;
  firebaseListen();
  renderProjectSwitcher();
}

// Creates a brand-new, empty project (registry entry + settings +
// empty schedule), writes it to Firebase, then switches to it. Admin
// only -- also guarded by Firebase rules.
function createProject(form) {
  if (USER_ROLE !== "admin") return;
  if (typeof db === "undefined") { alert("Live database isn't configured in this session."); return; }
  const name = (form.name || "").trim();
  const address = (form.address || "").trim();
  if (!name && !address) { alert("Project Name or Address is required."); return; }
  const id = uniqueProjectId(form.projectNumber ? name + "-" + form.projectNumber : (name || address));

  const registryEntry = {
    name: name || address,
    address: address || name,
    projectNumber: (form.projectNumber || "").trim(),
    client: (form.client || "").trim(),
    projectType: (form.projectType || "").trim(),
    startDate: form.startDate || isoDate(new Date()),
    targetCompletion: form.targetCompletion || isoDate(new Date()),
    status: form.status || "Not Started",
    projectManager: (form.projectManager || "").trim(),
    description: (form.description || "").trim(),
    coverImageDataUrl: form.coverImageDataUrl || null,
    notes: (form.notes || "").trim(),
    archived: false,
    order: nextRegistryOrder(),
    createdAt: new Date().toISOString(),
  };

  const settings = Object.assign({}, DEFAULT_SETTINGS, {
    title: registryEntry.name,
    address: registryEntry.address,
    clientName: registryEntry.client,
    projectType: registryEntry.projectType,
    description: registryEntry.description,
    start: registryEntry.startDate,
    targetCompletion: registryEntry.targetCompletion,
    status: registryEntry.status,
    projectManager: registryEntry.projectManager,
  });

  const schedule = {
    milestones: (form.copyFrom ? clonedMilestonesForNewProject(form.copyFrom) : []),
    trades: (form.copyFrom ? clonedTradesForNewProject(form.copyFrom) : []),
    budgetCategories: (form.copyFrom ? clonedBudgetCategoriesForNewProject(form.copyFrom) : []),
    holidays: deepClone(DEFAULT_HOLIDAYS),
    activity: [],
    lastUpdated: new Date().toISOString(),
  };

  const updates = {};
  updates[PROJECT_REGISTRY_KEY + "/" + id] = registryEntry;
  updates["projects/" + id + "/settings"] = settings;
  updates["projects/" + id + "/schedule"] = schedule;

  return db.ref().update(updates).then(() => {
    switchProject(id);
    logActivity(`Project created: "${registryEntry.name}".`);
  }).catch((err) => {
    console.error("Create project failed:", err);
    showSaveError(err);
  });
}

// Structural-only copy for "Duplicate Project": milestones/trades keep
// their scheduling shape (durations, dependencies, names, trade links)
// but every financial/gallery figure resets to zero/empty — per spec,
// invoices/payments/change orders/actuals/documents are NEVER copied.
function clonedMilestonesForNewProject(sourceProjectId) {
  const src = sourceProjectId === CURRENT_PROJECT_ID ? STATE.milestones : null;
  if (!src) return []; // duplicating a project other than the one currently loaded isn't supported client-side yet
  return deepClone(src).map(m => Object.assign({}, m, {
    status: "Not Started",
    progress: 0,
    contractPrice: 0,
    changeOrders: [],
    invoices: [],
    gallery: [],
  }));
}
function clonedTradesForNewProject(sourceProjectId) {
  const src = sourceProjectId === CURRENT_PROJECT_ID ? STATE.trades : null;
  if (!src) return [];
  return deepClone(src).map(t => Object.assign({}, t, {
    contractAmount: 0,
    hst: 0,
    workStatus: "Not Started",
    changeOrders: [],
    invoices: [],
    payments: [],
    updatedAt: new Date().toISOString(),
  }));
}
// Budget category STRUCTURE only (name, which trades it rolls up,
// notes) -- budget amounts and any manually-entered actuals reset to
// zero/null, since those are financial figures specific to this
// project, never copied per spec.
function clonedBudgetCategoriesForNewProject(sourceProjectId) {
  const src = sourceProjectId === CURRENT_PROJECT_ID ? STATE.budgetCategories : null;
  if (!src) return [];
  return deepClone(src).map(c => Object.assign({}, c, {
    budgetAmount: 0,
    manualActual: null,
  }));
}

function updateProjectRegistryEntry(id, patch) {
  if (USER_ROLE !== "admin" || typeof db === "undefined") return Promise.resolve();
  return db.ref(PROJECT_REGISTRY_KEY + "/" + id).update(patch).catch((err) => { showSaveError(err); throw err; });
}

function archiveProject(id) {
  if (!confirm("Archive this project? It will be hidden from the switcher but its data is kept and can be restored anytime.")) return;
  updateProjectRegistryEntry(id, { archived: true }).then(() => {
    logActivity(`Project archived: "${(PROJECT_REGISTRY[id] || {}).name || id}".`);
    renderAdminProjectsTab();
  });
}
function restoreProject(id) {
  updateProjectRegistryEntry(id, { archived: false }).then(() => {
    logActivity(`Project restored: "${(PROJECT_REGISTRY[id] || {}).name || id}".`);
    renderAdminProjectsTab();
  });
}

// One-time content migration: the schedule originally had a single combined
// "Foundation / Footings" milestone. This splits it into two separate
// milestones ("Footing" under AT McLaren, "Foundation" under Total
// Excavation) and makes sure those two trades exist and are linked
// correctly — without touching any financial data already entered against
// an existing trade of the same name. Idempotent: safe to call on every
// load, it only acts once (checks whether "Footing" already exists).
function migrateFootingFoundationSplit() {
  const combined = STATE.milestones.find(m => m.name === "Foundation / Footings");
  const alreadyMigrated = STATE.milestones.some(m => m.name === "Footing");
  if (!combined || alreadyMigrated) return false;

  const footingId = combined.id;
  const excavation = STATE.milestones.find(m => m.name === "Excavation");
  const newFoundationId = Math.max(...STATE.milestones.map(m => m.id)) + 1;

  // Repoint anything that depended on the old combined milestone to the new Foundation
  STATE.milestones.forEach(m => {
    if (m.id === footingId) return;
    m.dependency = (m.dependency || []).map(d => (d === footingId ? newFoundationId : d));
  });

  combined.name = "Footing";
  combined.trade = "AT McLaren";
  combined.duration = 3;
  combined.notes = "Footing forms, rebar, pour.";

  const foundation = {
    id: newFoundationId, name: "Foundation", duration: 3, dependency: [footingId], manualStart: null,
    status: "Not Started", progress: 0, trade: "Total Excavation",
    notes: "Foundation walls & slab per Total Excavation scope.",
    contractPrice: 0, changeOrders: [], invoices: [],
    paymentDetails: { vendorName: "Total Excavation", poNumber: "", paymentTerms: "", paymentMethod: "", bankName: "", accountName: "", accountLast4: "", paymentReference: "", notes: "" },
  };
  STATE.milestones.push(foundation);

  let atMcLaren = STATE.trades.find(t => t.tradeName === "AT McLaren");
  if (!atMcLaren) {
    atMcLaren = {
      tradeId: nextTradeId(), tradeName: "AT McLaren", vendor: "AT McLaren", scope: "Footing",
      milestoneIds: [footingId], contractAmount: 0, hst: 0, workStatus: "Not Started",
      paymentTerms: "", poNumber: "", notes: "", active: true,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      changeOrders: [], invoices: [], payments: [],
    };
    STATE.trades.push(atMcLaren);
  } else if (!atMcLaren.milestoneIds.includes(footingId)) {
    atMcLaren.milestoneIds.push(footingId);
  }

  let totalExc = STATE.trades.find(t => t.tradeName === "Total Excavation");
  if (!totalExc) {
    totalExc = {
      tradeId: nextTradeId(), tradeName: "Total Excavation", vendor: "Total Excavation", scope: "Excavation & Foundation",
      milestoneIds: [excavation ? excavation.id : null, newFoundationId].filter(x => x !== null),
      contractAmount: 0, hst: 0, workStatus: "Not Started",
      paymentTerms: "", poNumber: "", notes: "", active: true,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      changeOrders: [], invoices: [], payments: [],
    };
    STATE.trades.push(totalExc);
  } else {
    if (excavation && !totalExc.milestoneIds.includes(excavation.id)) totalExc.milestoneIds.push(excavation.id);
    if (!totalExc.milestoneIds.includes(newFoundationId)) totalExc.milestoneIds.push(newFoundationId);
  }

  STATE.lastUpdated = new Date();
  logActivity('Schedule updated: "Foundation / Footings" split into separate Footing (AT McLaren) and Foundation (Total Excavation) milestones.');
  return true;
}

function firebaseListen() {
  if (typeof db === "undefined") {
    // Firebase not configured — fall back to local-only mode.
    STATE.settings = deepClone(DEFAULT_SETTINGS);
    PROJECT = Object.assign({}, STATE.settings, { id: CURRENT_PROJECT_ID });
    logActivity(`Schedule loaded — baseline for ${PROJECT.address}, project start ${fmtDate(parseISO(PROJECT.start))}.`);
    renderAll();
    return;
  }

  migrateLegacyDataIfNeeded().finally(() => {
    // Settings listener
    SETTINGS_REF = db.ref(`projects/${CURRENT_PROJECT_ID}/settings`);
    SETTINGS_REF.on("value", (snapshot) => {
      const val = snapshot.val();
      if (!val) {
        STATE.settings = deepClone(DEFAULT_SETTINGS);
        db.ref(`projects/${CURRENT_PROJECT_ID}/settings`).set(STATE.settings).catch(() => {});
      } else {
        STATE.settings = Object.assign({}, DEFAULT_SETTINGS, val);
      }
      PROJECT = Object.assign({}, STATE.settings, { id: CURRENT_PROJECT_ID });
      renderAll();
    }, (err) => console.error("Settings listen failed:", err));

    // Schedule listener (milestones / trades / holidays / activity)
    SCHEDULE_REF = db.ref(`projects/${CURRENT_PROJECT_ID}/schedule`);
    SCHEDULE_REF.on("value", (snapshot) => {
      const val = snapshot.val();
      if (!val) {
        // Nothing in the database yet. Only this repo's own baked-in
        // PROJECT_ID gets the 43-Munn baseline (first-ever load of the
        // original site) — any other project (created via Admin >
        // Projects) starts genuinely empty, never inheriting Munn's
        // milestones/trades.
        const isOriginalProject = CURRENT_PROJECT_ID === PROJECT_ID;
        STATE.milestones = isOriginalProject ? deepClone(BASELINE_MILESTONES) : [];
        STATE.trades = isOriginalProject ? deepClone(BASELINE_TRADES) : [];
        STATE.budgetCategories = [];
        STATE.holidays = deepClone(DEFAULT_HOLIDAYS);
        STATE.activity = [];
        STATE.lastUpdated = new Date();
        logActivity(`Schedule loaded — baseline for ${PROJECT.address}, project start ${fmtDate(parseISO(PROJECT.start))}.`);
        firebaseSaveIfAdminElseSeed();
        return;
      }
      STATE.milestones = (val.milestones || deepClone(BASELINE_MILESTONES)).map(rehydrateMilestone);
      STATE.trades = (val.trades || []).map(rehydrateTrade);
      STATE.budgetCategories = (val.budgetCategories || []).map(rehydrateBudgetCategory);
      STATE.holidays = val.holidays || deepClone(DEFAULT_HOLIDAYS);
      STATE.activity = (val.activity || []).map(a => ({ text: a.text, time: new Date(a.time) }));
      STATE.lastUpdated = val.lastUpdated ? new Date(val.lastUpdated) : new Date();
      FIREBASE_READY = true;
      const migratedSplit = migrateFootingFoundationSplit();
      const migratedOrder = migrateMilestoneOrder();
      if ((migratedSplit || migratedOrder) && USER_ROLE === "admin") firebaseSave();
      renderAll();
      renderAdminMilestonesList();
    }, (err) => {
      console.error("Firebase listen failed:", err);
    });
  });
}

// First-ever load with no data yet: only an admin write actually persists
// (client role can't write per the security rules) — for a brand-new,
// still-empty project this just means the next admin visit seeds it.
function firebaseSaveIfAdminElseSeed() {
  if (USER_ROLE === "admin") firebaseSave();
  renderAll();
}

// One-time migration for sites upgraded from the pre-admin-portal version,
// which stored a single project's data at a flat "schedule" (or
// "schedule_<id>") path instead of projects/{PROJECT_ID}/schedule. Safe to
// run on every load: it only copies data across if the new location is
// still empty AND a legacy location has data. Never deletes the old node.
function migrateLegacyDataIfNeeded() {
  const newRef = db.ref(`projects/${CURRENT_PROJECT_ID}/schedule`);
  return newRef.once("value").then((snap) => {
    if (snap.exists()) return; // already migrated / already has data
    const legacyPaths = ["schedule", "schedule_" + CURRENT_PROJECT_ID.replace(/-/g, "")];
    return legacyPaths.reduce((chain, path) => {
      return chain.then((found) => {
        if (found) return found;
        return db.ref(path).once("value").then((legacySnap) => {
          if (!legacySnap.exists()) return false;
          return newRef.set(legacySnap.val()).then(() => {
            console.log(`Migrated legacy data from "${path}" to "projects/${CURRENT_PROJECT_ID}/schedule".`);
            return true;
          });
        });
      });
    }, Promise.resolve(false));
  }).catch((err) => {
    console.warn("Legacy data migration check failed (non-fatal):", err);
  });
}

/* ============================================================
   AUTH — Admin vs. Client role
   Any signed-in Firebase Auth user is treated as admin. Create
   admin accounts in the Firebase console (Authentication → Users)
   — see README. No passwords are ever stored in this codebase.
   ============================================================ */

function initAuth() {
  if (typeof auth === "undefined") { applyRoleUI(); return; }
  auth.onAuthStateChanged((user) => {
    CURRENT_USER = user;
    USER_ROLE = user ? "admin" : "client";
    applyRoleUI();
    renderAll();
    // The registry listener only re-fires when project_registry's DATA
    // changes -- logging in doesn't touch that data, so without this the
    // switcher could stay hidden and the bootstrap-registration of this
    // repo's own project could never run if the registry's first-ever
    // fire happened while still signed out (i.e. every normal page load).
    ensureCurrentProjectInRegistry();
    renderProjectSwitcher();
  });
}

function applyRoleUI() {
  document.body.classList.toggle("role-admin", USER_ROLE === "admin");
  const roleBadge = document.getElementById("roleBadge");
  if (roleBadge) roleBadge.textContent = USER_ROLE === "admin" ? "Admin (editing enabled)" : "Client view (read-only)";
  const btnLogin = document.getElementById("btnLogin");
  if (btnLogin) btnLogin.style.display = USER_ROLE === "admin" ? "none" : "inline-flex";
}

function handleLogin() {
  const email = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;
  const errEl = document.getElementById("loginError");
  errEl.textContent = "";
  if (!email || !password) { errEl.textContent = "Enter email and password."; return; }
  auth.signInWithEmailAndPassword(email, password).then(() => {
    closeLoginModal();
    logActivity("Admin signed in.");
  }).catch((err) => {
    errEl.textContent = err.message || "Login failed.";
  });
}

function handleLogout() {
  auth.signOut().then(() => {
    logActivity("Admin signed out.");
  });
}

function openLoginModal() {
  document.getElementById("loginEmail").value = "";
  document.getElementById("loginPassword").value = "";
  document.getElementById("loginError").textContent = "";
  document.getElementById("loginModalOverlay").classList.add("show");
}
function closeLoginModal() {
  document.getElementById("loginModalOverlay").classList.remove("show");
}

/* ============================================================
   TRADES — calculation engine
   Trades are independent records (own tradeId, optional link to
   a milestone via milestoneId). All financial figures derive live
   from a trade's changeOrders + invoices + payments; nothing here
   is stored pre-computed.
   ============================================================ */

function fmtMoney(n) {
  const v = Number(n) || 0;
  return v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function activeTrades() { return STATE.trades.filter(t => t.active); }

function approvedChangeOrderTotal(t) {
  return (t.changeOrders || []).filter(c => c.status === "Approved").reduce((s, c) => s + (Number(c.amount) || 0), 0);
}

function revisedContractValue(t) {
  return (Number(t.contractAmount) || 0) + (Number(t.hst) || 0) + approvedChangeOrderTotal(t);
}

function tradeTotalInvoiced(t) {
  return (t.invoices || []).reduce((s, inv) => s + (Number(inv.total) || 0), 0);
}

function tradeTotalPaid(t) {
  return (t.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
}

function tradeOutstanding(t) {
  return revisedContractValue(t) - tradeTotalPaid(t);
}

function invoicePaidAmount(t, invoiceId) {
  return (t.payments || []).filter(p => p.invoiceId === invoiceId).reduce((s, p) => s + (Number(p.amount) || 0), 0);
}

function invoiceBalance(t, inv) {
  return (Number(inv.total) || 0) - invoicePaidAmount(t, inv.invoiceId);
}

function invoiceOverdue(t, inv) {
  if (!inv.dueDate) return false;
  if (invoiceBalance(t, inv) <= 0) return false;
  return parseISO(inv.dueDate) < new Date();
}

function tradePaymentStatus(t) {
  const invoices = t.invoices || [], payments = t.payments || [];
  if (invoices.length === 0 && payments.length === 0) return "Not Invoiced";
  if (invoices.some(inv => invoiceOverdue(t, inv))) return "Overdue";
  const paid = tradeTotalPaid(t);
  const revised = revisedContractValue(t);
  if (paid <= 0) return "Unpaid";
  if (revised > 0 && paid >= revised) return "Paid";
  return "Partially Paid";
}

function pendingInvoiceCount() {
  let n = 0;
  activeTrades().forEach(t => (t.invoices || []).forEach(inv => { if (invoiceBalance(t, inv) > 0) n++; }));
  return n;
}

function financialTotals() {
  return activeTrades().reduce((acc, t) => {
    acc.contract += revisedContractValue(t);
    acc.invoiced += tradeTotalInvoiced(t);
    acc.paid += tradeTotalPaid(t);
    acc.outstanding += tradeOutstanding(t);
    return acc;
  }, { contract: 0, invoiced: 0, paid: 0, outstanding: 0 });
}

function tradesForMilestone(milestoneId) {
  return STATE.trades.filter(t => (t.milestoneIds || []).includes(milestoneId));
}

/* ============================================================
   BUDGET VS ACTUAL
   A budget category links to zero or more trades. Committed /
   invoiced / paid are always DERIVED live from those trades' real
   financial records (never stored) -- same "never assume paid ==
   actual" principle as the trade engine. "Actual Expense" depends on
   the project's Actual Expense Basis setting: Invoice Amount, Paid
   Amount, or a manually-entered figure per category (for costs that
   don't run through the trade/invoice system at all, e.g. permits).
   ============================================================ */

function tradesForCategory(c) {
  const ids = c.tradeIds || [];
  return STATE.trades.filter(t => ids.includes(t.tradeId));
}
function categoryCommitted(c) { return tradesForCategory(c).reduce((s, t) => s + revisedContractValue(t), 0); }
function categoryInvoiced(c) { return tradesForCategory(c).reduce((s, t) => s + tradeTotalInvoiced(t), 0); }
function categoryPaid(c) { return tradesForCategory(c).reduce((s, t) => s + tradeTotalPaid(t), 0); }

function actualExpenseBasis() { return (STATE.settings && STATE.settings.actualExpenseBasis) || "Invoice"; }

function categoryActual(c) {
  const basis = actualExpenseBasis();
  if (basis === "Paid") return categoryPaid(c);
  if (basis === "Manual") return Number(c.manualActual) || 0;
  return categoryInvoiced(c); // default: Invoice Amount
}

function categoryVariance(c) { return (Number(c.budgetAmount) || 0) - categoryActual(c); }
function categoryVariancePct(c) {
  const budget = Number(c.budgetAmount) || 0;
  if (budget === 0) return null;
  return (categoryVariance(c) / budget) * 100;
}
function categoryStatus(c) {
  const budget = Number(c.budgetAmount) || 0;
  const actual = categoryActual(c);
  if (budget === 0 && actual === 0) return "No Budget Set";
  if (actual > budget) return "Over Budget";
  if (categoryCommitted(c) > budget) return "At Risk";
  return "On Budget";
}
function categoryStatusClass(status) {
  const map = { "Over Budget": "st-overdue", "At Risk": "st-pending", "On Budget": "st-approved", "No Budget Set": "st-gray" };
  return map[status] || "st-gray";
}

function budgetTotals() {
  return STATE.budgetCategories.reduce((acc, c) => {
    acc.budget += Number(c.budgetAmount) || 0;
    acc.committed += categoryCommitted(c);
    acc.invoiced += categoryInvoiced(c);
    acc.paid += categoryPaid(c);
    acc.actual += categoryActual(c);
    return acc;
  }, { budget: 0, committed: 0, invoiced: 0, paid: 0, actual: 0 });
}

function sanitizeBudgetCategory(c) {
  return {
    id: c.id,
    name: c.name || "",
    budgetAmount: Number(c.budgetAmount) || 0,
    tradeIds: Array.isArray(c.tradeIds) ? c.tradeIds : [],
    manualActual: (c.manualActual === undefined || c.manualActual === null || c.manualActual === "") ? null : Number(c.manualActual),
    notes: c.notes || "",
  };
}
function rehydrateBudgetCategory(c) {
  return {
    ...c,
    budgetAmount: Number(c.budgetAmount) || 0,
    tradeIds: Array.isArray(c.tradeIds) ? c.tradeIds : [],
    manualActual: (c.manualActual === undefined || c.manualActual === null) ? null : Number(c.manualActual),
    notes: c.notes || "",
  };
}

function nextBudgetCategoryId() {
  let max = 0;
  STATE.budgetCategories.forEach(c => {
    const m = /^BUD-(\d+)$/.exec(c.id || "");
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return "BUD-" + String(max + 1).padStart(3, "0");
}

function nextTradeId() {
  let max = 0;
  STATE.trades.forEach(t => {
    const m = /^TRD-(\d+)$/.exec(t.tradeId || "");
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return "TRD-" + String(max + 1).padStart(3, "0");
}

let FIN_ID_SEQ = Date.now();
function nextFinId() { return ++FIN_ID_SEQ; }

// Session-only object URLs for uploaded PDFs — never synced to Firebase.
// Keyed by invoice id. This is the prototype's local-preview layer;
// real deployments should point fileName at real document storage.
const LOCAL_INVOICE_FILES = {};

/* ============================================================
   ACTIVITY FEED
   ============================================================ */

function logActivity(text) {
  STATE.activity.unshift({ text, time: new Date() });
  if (STATE.activity.length > 200) STATE.activity.pop();
  STATE.activityPage = 1;
}

/* ============================================================
   RENDERING
   ============================================================ */

let CACHED_SCHEDULE = {};

function renderAll() {
  CACHED_SCHEDULE = getComputed();
  renderHeader();
  renderDashboard();
  renderSummary();
  renderHealth();
  renderLegendFilters();
  renderGantt();
  renderMobileList();
  renderUpcoming();
  renderActivity();
  renderHolidays();
  renderFinancialSummary();
  renderTradeCostTable();
  renderBudgetVsActual();
  document.getElementById("lastUpdated").textContent = "Last updated: " + STATE.lastUpdated.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  const syncEl = document.getElementById("syncStatus");
  if (syncEl) syncEl.textContent = FIREBASE_READY ? "🔥 Live sync on" : "Local mode";
}

function renderHeader() {
  document.getElementById("projAddress").textContent = PROJECT.address.toUpperCase();
  document.getElementById("projType").textContent = PROJECT.type;
  const subEl = document.getElementById("projSubtitle");
  if (subEl) subEl.textContent = PROJECT.subtitle || "Project milestone schedule & live tracker";
  document.title = PROJECT.address + " — Project Schedule";
  const footerLabel = document.getElementById("footerProjectLabel");
  if (footerLabel) footerLabel.textContent = PROJECT.footerText || (PROJECT.address + " — Project Milestone Schedule");

  const logoSlot = document.getElementById("brandLogoSlot");
  const logoImg = document.getElementById("brandLogoImg");
  if (logoSlot && logoImg) {
    if (PROJECT.companyLogoDataUrl) {
      logoImg.src = PROJECT.companyLogoDataUrl;
      logoSlot.style.display = "flex";
    } else {
      logoSlot.style.display = "none";
    }
  }
}

function renderDashboard() {
  const schedule = CACHED_SCHEDULE;
  const projected = getProjectedCompletion(schedule);
  const target = parseISO(PROJECT.targetCompletion);
  const today = new Date();
  const progress = getOverallProgress();
  const daysRemaining = projected ? Math.max(0, calculateBusinessDays(today, projected)) : 0;
  const variance = projected ? calculateBusinessDays(target, projected) : 0;

  let statusLabel, statusClass;
  if (variance < 0) { statusLabel = "AHEAD OF SCHEDULE"; statusClass = "green"; }
  else if (variance === 0) { statusLabel = "ON SCHEDULE"; statusClass = "blue"; }
  else { statusLabel = "BEHIND SCHEDULE"; statusClass = "red"; }

  document.getElementById("metricProgress").textContent = progress + "%";
  document.getElementById("metricDaysRemaining").textContent = daysRemaining + " Business Days";
  document.getElementById("metricProjected").textContent = projected ? fmtDate(projected) : "—";
  const statusEl = document.getElementById("metricStatus");
  statusEl.textContent = statusLabel;
  statusEl.className = "metric-value badge-text " + statusClass;

  document.getElementById("varianceNote").textContent =
    variance === 0 ? "Exactly on target" :
    (variance < 0 ? `${Math.abs(variance)} business day${Math.abs(variance) === 1 ? "" : "s"} ahead of target` : `${variance} business day${variance === 1 ? "" : "s"} behind target`);
}

function renderSummary() {
  const schedule = CACHED_SCHEDULE;
  const projected = getProjectedCompletion(schedule);
  const counts = getCounts();
  const el = document.getElementById("summaryGrid");
  el.innerHTML = "";
  const rows = [
    ["Project", PROJECT.address],
    ["Client", PROJECT.clientName || "—"],
    ["Start", fmtDate(parseISO(PROJECT.start))],
    ["Target Completion", fmtDate(parseISO(PROJECT.targetCompletion))],
    ["Projected Completion", projected ? fmtDate(projected) : "—"],
    ["Construction Manager", PROJECT.projectManager || "—"],
    ["Project Operations Coordinator", PROJECT.operationsCoordinator || "—"],
    ["Total Milestones", STATE.milestones.length],
    ["Completed", counts["Complete"] || 0],
    ["In Progress", counts["In Progress"] || 0],
    ["Upcoming", counts["Not Started"] || 0],
    ["Delayed", counts["Delayed"] || 0],
    ["Overall Progress", getOverallProgress() + "%"],
  ];
  rows.forEach(([label, val]) => {
    const d = document.createElement("div");
    d.className = "summary-row";
    d.innerHTML = `<span class="summary-label">${label}</span><span class="summary-val">${val}</span>`;
    el.appendChild(d);
  });
}

function renderHealth() {
  const schedule = CACHED_SCHEDULE;
  const projected = getProjectedCompletion(schedule);
  const target = parseISO(PROJECT.targetCompletion);
  const variance = projected ? calculateBusinessDays(target, projected) : 0;
  const counts = getCounts();
  const h = getScheduleHealth(variance, counts);
  document.getElementById("healthIcon").textContent = h.icon;
  document.getElementById("healthLabel").textContent = h.label;
  document.getElementById("healthLabel").className = "health-label " + h.level;
  document.getElementById("healthExplain").textContent = h.explanation;

  const scoreEl = document.getElementById("metricOnTrackScore");
  if (scoreEl) {
    const score = getOnTrackScore(variance, counts);
    scoreEl.textContent = score + "%";
    scoreEl.className = "metric-value " + (score >= 85 ? "green" : score >= 60 ? "" : "red");
  }
}

function renderLegendFilters() {
  const el = document.getElementById("statusFilters");
  el.innerHTML = "";
  ["All", ...STATUS_OPTIONS].forEach(s => {
    const btn = document.createElement("button");
    btn.className = "chip" + (STATE.statusFilter === s ? " active" : "") + (s !== "All" ? " dot-" + STATUS_COLOR[s] : "");
    btn.textContent = s;
    btn.onclick = () => { STATE.statusFilter = s; renderAll(); };
    el.appendChild(btn);
  });
}

function visibleMilestones() {
  if (STATE.statusFilter === "All") return STATE.milestones;
  return STATE.milestones.filter(m => m.status === STATE.statusFilter);
}

function statusOfDate(m, schedule, today) {
  // Determine display bucket for coloring the bar, independent of manual status label
  return m.status;
}

function renderGantt() {
  const schedule = CACHED_SCHEDULE;
  const container = document.getElementById("ganttBody");
  container.innerHTML = "";
  const projectStart = parseISO(PROJECT.start);
  const target = parseISO(PROJECT.targetCompletion);
  const today = new Date();
  const list = visibleMilestones();

  const lastFinish = getProjectedCompletion(schedule) || target;
  const spanEnd = new Date(Math.max(target.getTime(), lastFinish.getTime()));
  const totalDays = Math.round((spanEnd - projectStart) / 86400000) + 15;
  const PX = 8;
  const LABEL_W = 230;

  const monthsRow = document.getElementById("ganttMonths");
  monthsRow.innerHTML = "";
  monthsRow.style.width = (totalDays * PX) + "px";
  let mCursor = new Date(projectStart.getFullYear(), projectStart.getMonth(), 1);
  while (mCursor <= spanEnd) {
    const offset = Math.round((mCursor - projectStart) / 86400000);
    if (offset >= 0) {
      const m = document.createElement("div");
      m.className = "gantt-month";
      m.style.left = (offset * PX) + "px";
      m.textContent = mCursor.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
      monthsRow.appendChild(m);
    }
    mCursor.setMonth(mCursor.getMonth() + 1);
  }

  container.style.width = (totalDays * PX) + "px";

  list.forEach(m => {
    const sched = schedule[m.id];
    if (!sched) return;
    const row = document.createElement("div");
    row.className = "gantt-row";

    const label = document.createElement("div");
    label.className = "gantt-label";
    label.innerHTML = `<span class="gname">${m.name}</span><span class="gsub">${fmtDateShort(sched.start)} – ${fmtDateShort(sched.finish)} · ${m.duration}d</span>`;
    label.style.width = LABEL_W + "px";
    label.onclick = () => openModal(m.id);
    row.appendChild(label);

    const lane = document.createElement("div");
    lane.className = "gantt-lane";
    lane.style.width = (totalDays * PX) + "px";

    const off = Math.round((sched.start - projectStart) / 86400000);
    const span = Math.round((sched.finish - sched.start) / 86400000) + 1;
    const bar = document.createElement("div");
    bar.className = "gantt-bar bar-" + STATUS_COLOR[m.status];
    bar.style.left = (off * PX) + "px";
    bar.style.width = Math.max(span * PX - 2, 6) + "px";
    bar.title = `${m.name}: ${fmtDate(sched.start)} → ${fmtDate(sched.finish)} (${m.duration} business days) — ${m.status}`;
    bar.onclick = () => openModal(m.id);

    const fill = document.createElement("div");
    fill.className = "gantt-bar-fill";
    fill.style.width = m.progress + "%";
    bar.appendChild(fill);

    lane.appendChild(bar);
    row.appendChild(lane);
    container.appendChild(row);
  });

  // today marker
  const oldMarkers = document.querySelectorAll(".gantt-todaymark, .gantt-targetmark");
  oldMarkers.forEach(n => n.remove());
  const ganttWrap = document.getElementById("ganttWrap");
  const bodyHeight = 40 + list.length * 40;

  const todayOff = Math.round((today - projectStart) / 86400000);
  if (todayOff >= -2 && todayOff <= totalDays) {
    const line = document.createElement("div");
    line.className = "gantt-todaymark";
    line.style.left = (LABEL_W + todayOff * PX) + "px";
    line.style.height = bodyHeight + "px";
    line.innerHTML = `<span>TODAY</span>`;
    ganttWrap.appendChild(line);
  }
  const targetOff = Math.round((target - projectStart) / 86400000);
  const tLine = document.createElement("div");
  tLine.className = "gantt-targetmark";
  tLine.style.left = (LABEL_W + targetOff * PX) + "px";
  tLine.style.height = bodyHeight + "px";
  tLine.innerHTML = `<span>TARGET</span>`;
  ganttWrap.appendChild(tLine);
}

function renderMobileList() {
  const schedule = CACHED_SCHEDULE;
  const container = document.getElementById("mobileList");
  container.innerHTML = "";
  visibleMilestones().forEach(m => {
    const sched = schedule[m.id];
    if (!sched) return;
    const card = document.createElement("div");
    card.className = "mcard";
    card.onclick = () => openModal(m.id);
    card.innerHTML = `
      <div class="mcard-top">
        <span class="mcard-name">${m.name}</span>
        <span class="status-badge bg-${STATUS_COLOR[m.status]}">${m.status}</span>
      </div>
      <div class="mcard-dates">${fmtDate(sched.start)} → ${fmtDate(sched.finish)} · ${m.duration} business days</div>
      <div class="progress-track"><div class="progress-fill fill-${STATUS_COLOR[m.status]}" style="width:${m.progress}%"></div></div>
      <div class="mcard-meta">${m.trade}</div>
    `;
    container.appendChild(card);
  });
}

function renderUpcoming() {
  const schedule = CACHED_SCHEDULE;
  const today = new Date();
  const upcoming = STATE.milestones
    .filter(m => m.status === "Not Started" || m.status === "In Progress")
    .map(m => ({ m, sched: schedule[m.id] }))
    .filter(x => x.sched)
    .sort((a, b) => a.sched.start - b.sched.start)
    .slice(0, 5);
  const el = document.getElementById("upcomingList");
  el.innerHTML = "";
  if (upcoming.length === 0) {
    el.innerHTML = `<div class="empty-note">No upcoming milestones.</div>`;
    return;
  }
  upcoming.forEach(({ m, sched }) => {
    const row = document.createElement("div");
    row.className = "upcoming-row";
    row.onclick = () => openModal(m.id);
    row.innerHTML = `
      <div class="upcoming-name">${m.name}</div>
      <div class="upcoming-dates">${fmtDateShort(sched.start)} – ${fmtDateShort(sched.finish)}</div>
      <div class="upcoming-dur">${m.duration}d</div>
      <div class="upcoming-trade">${m.trade}</div>
      <span class="status-badge bg-${STATUS_COLOR[m.status]}">${m.status}</span>
    `;
    el.appendChild(row);
  });
}

function renderActivity() {
  const el = document.getElementById("activityList");
  el.innerHTML = "";
  if (STATE.activity.length === 0) {
    el.innerHTML = `<div class="empty-note">No changes yet this session.</div>`;
    updateActivityPagerControls(1, 1);
    return;
  }
  const totalPages = Math.max(1, Math.ceil(STATE.activity.length / ACTIVITY_PAGE_SIZE));
  STATE.activityPage = Math.min(Math.max(1, STATE.activityPage), totalPages);
  const start = (STATE.activityPage - 1) * ACTIVITY_PAGE_SIZE;
  const pageItems = STATE.activity.slice(start, start + ACTIVITY_PAGE_SIZE);
  pageItems.forEach(a => {
    const row = document.createElement("div");
    row.className = "activity-row";
    row.innerHTML = `<span class="activity-dot"></span><span class="activity-text">${escapeHtml(a.text)}</span><span class="activity-time">${a.time.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</span>`;
    el.appendChild(row);
  });
  updateActivityPagerControls(STATE.activityPage, totalPages);
}

function updateActivityPagerControls(page, totalPages) {
  const pager = document.getElementById("activityPager");
  if (!pager) return;
  pager.style.display = totalPages > 1 ? "flex" : "none";
  document.getElementById("activityPageLabel").textContent = `Page ${page} of ${totalPages}`;
  document.getElementById("btnActivityPrev").disabled = page <= 1;
  document.getElementById("btnActivityNext").disabled = page >= totalPages;
}

function renderHolidays() {
  const el = document.getElementById("holidayList");
  el.innerHTML = "";
  STATE.holidays
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
    .forEach(h => {
      const row = document.createElement("div");
      row.className = "holiday-row";
      row.innerHTML = `<span>${fmtDate(parseISO(h.date))} — ${h.name}</span>`;
      const rm = document.createElement("button");
      rm.className = "icon-btn admin-only";
      rm.textContent = "×";
      rm.onclick = () => {
        if (USER_ROLE !== "admin") return;
        STATE.holidays = STATE.holidays.filter(x => !(x.date === h.date && x.name === h.name));
        STATE.lastUpdated = new Date();
        logActivity(`Holiday removed: ${h.name} (${h.date})`);
        firebaseSave();
        renderAll();
      };
      row.appendChild(rm);
      el.appendChild(row);
    });
}

function renderFinancialSummary() {
  const totals = financialTotals();
  const el = document.getElementById("finSummaryMetrics");
  if (!el) return;
  el.innerHTML = `
    <div class="metric-card">
      <div class="metric-label">Total Contract Value</div>
      <div class="metric-value">${fmtMoney(totals.contract)}</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">Total Invoiced</div>
      <div class="metric-value">${fmtMoney(totals.invoiced)}</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">Total Paid</div>
      <div class="metric-value green">${fmtMoney(totals.paid)}</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">Total Outstanding</div>
      <div class="metric-value ${totals.outstanding > 0 ? "red" : ""}">${fmtMoney(totals.outstanding)}</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">Pending Invoices</div>
      <div class="metric-value">${pendingInvoiceCount()}</div>
    </div>
  `;
}

function statusPillClass(status) {
  const map = {
    "Paid": "st-paid", "Partially Paid": "st-partial", "Unpaid": "st-unpaid",
    "Overdue": "st-overdue", "Pending": "st-pending", "Approved": "st-approved", "Rejected": "st-rejected",
    "Not Invoiced": "st-gray",
  };
  return map[status] || "st-pending";
}

function visibleTrades() {
  if (STATE.tradeFilter === "archived") return STATE.trades.filter(t => !t.active);
  if (STATE.tradeFilter === "all") return STATE.trades;
  return STATE.trades.filter(t => t.active);
}

function renderTradeFilterTabs() {
  const el = document.getElementById("tradeFilterTabs");
  if (!el) return;
  const opts = [["active", "Active"], ["archived", "Archived"], ["all", "All"]];
  el.innerHTML = "";
  opts.forEach(([key, label]) => {
    const btn = document.createElement("button");
    btn.className = "chip" + (STATE.tradeFilter === key ? " active" : "");
    btn.textContent = label;
    btn.onclick = () => { STATE.tradeFilter = key; renderTradeCostTable(); renderTradeFilterTabs(); };
    el.appendChild(btn);
  });
}

function milestoneName(id) {
  const m = STATE.milestones.find(x => x.id === id);
  return m ? m.name : "—";
}

function milestoneNamesList(ids) {
  if (!ids || !ids.length) return "—";
  return ids.map(id => milestoneName(id)).join(", ");
}

// Shared row renderer for both the Trade Costs table and the Site
// Rentals table below it -- same financial engine, same actions, just a
// different slice of STATE.trades by `category`.
function renderTradeRowsInto(bodyId, list, emptyMsg) {
  const body = document.getElementById(bodyId);
  if (!body) return;
  body.innerHTML = "";
  if (list.length === 0) {
    body.innerHTML = `<tr><td colspan="11" class="empty-note">${emptyMsg}</td></tr>`;
    return;
  }
  list.forEach(t => {
    const invoiced = tradeTotalInvoiced(t);
    const paid = tradeTotalPaid(t);
    const outstanding = tradeOutstanding(t);
    const status = tradePaymentStatus(t);
    const tr = document.createElement("tr");
    tr.className = "clickable" + (t.active ? "" : " archived-row");
    tr.onclick = (e) => { if (!e.target.closest("button")) openTradeModal(t.tradeId); };
    tr.innerHTML = `
      <td>${escapeHtml(t.tradeName)}</td>
      <td>${escapeHtml(t.vendor) || "—"}</td>
      <td>${escapeHtml(t.scope) || "—"}</td>
      <td>${escapeHtml(milestoneNamesList(t.milestoneIds))}</td>
      <td class="num">${fmtMoney(revisedContractValue(t))}</td>
      <td class="num">${fmtMoney(invoiced)}</td>
      <td class="num">${fmtMoney(paid)}</td>
      <td class="num">${fmtMoney(outstanding)}</td>
      <td class="num">${(t.invoices || []).length}</td>
      <td><span class="status-pill ${statusPillClass(status)}">${status}</span>${!t.active ? '<span class="status-pill st-gray" style="margin-left:4px;">Archived</span>' : ""}</td>
      <td class="trade-actions-cell">
        <button data-taction="edit" data-tid="${t.tradeId}">${USER_ROLE === "admin" ? "Edit" : "View"}</button>
        ${t.active ? `<button class="admin-only" data-taction="archive" data-tid="${t.tradeId}">Archive</button>` : `<button class="admin-only" data-taction="restore" data-tid="${t.tradeId}">Restore</button>`}
      </td>
    `;
    body.appendChild(tr);
  });
}

function renderTradeCostTable() {
  const list = visibleTrades().filter(t => t.category !== "Site Rentals");
  renderTradeRowsInto("tradeCostTableBody", list, 'No trades yet. Click "+ Add Trade" to create one.');
  renderSiteRentalsTable();
}

function renderSiteRentalsTable() {
  const card = document.getElementById("siteRentalsCard");
  if (!card) return;
  const list = visibleTrades().filter(t => t.category === "Site Rentals");
  card.style.display = (list.length === 0 && STATE.tradeFilter === "active") ? "none" : "block";
  renderTradeRowsInto("siteRentalsTableBody", list, 'No site rentals yet. Add a trade and set its Category to "Site Rentals" — e.g. temporary fencing, portable toilets, dumpster/bin rental, equipment rental.');
}

function handleTradeTableClick(e) {
  const btn = e.target.closest("[data-taction]");
  if (!btn) return;
  e.stopPropagation();
  const tid = btn.dataset.tid;
  const action = btn.dataset.taction;
  if (action === "edit") openTradeModal(tid);
  if (action === "archive") archiveTradePrompt(tid);
  if (action === "restore") restoreTrade(tid);
}

/* ============================================================
   BUDGET VS ACTUAL — rendering + modal
   ============================================================ */

function fmtPct(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return sign + n.toFixed(1) + "%";
}

function renderBudgetVsActual() {
  const card = document.getElementById("budgetCard");
  if (!card) return;

  // Basis control: editable select for admins, plain text for clients.
  const basisSelect = document.getElementById("budgetBasisSelect");
  const basisReadonly = document.getElementById("budgetBasisReadonly");
  const basis = actualExpenseBasis();
  if (basisSelect) basisSelect.value = basis;
  if (basisReadonly) {
    const labels = { Invoice: "Invoice Amount", Paid: "Paid Amount", Manual: "Manually Entered" };
    basisReadonly.textContent = "Actual Expense Basis: " + (labels[basis] || basis);
    basisReadonly.style.display = USER_ROLE === "admin" ? "none" : "inline";
  }

  const totals = budgetTotals();
  const summaryEl = document.getElementById("budgetSummaryMetrics");
  if (summaryEl) {
    const remaining = totals.budget - totals.actual;
    summaryEl.innerHTML = `
      <div class="metric-card"><div class="metric-label">Total Project Budget</div><div class="metric-value">${fmtMoney(totals.budget)}</div></div>
      <div class="metric-card"><div class="metric-label">Total Committed</div><div class="metric-value">${fmtMoney(totals.committed)}</div></div>
      <div class="metric-card"><div class="metric-label">Total Actual Expense</div><div class="metric-value">${fmtMoney(totals.actual)}</div></div>
      <div class="metric-card"><div class="metric-label">Remaining Budget</div><div class="metric-value ${remaining < 0 ? "red" : "green"}">${fmtMoney(remaining)}</div></div>
      <div class="metric-card"><div class="metric-label">Project Variance</div><div class="metric-value ${remaining < 0 ? "red" : ""}">${fmtMoney(remaining)}</div></div>
    `;
  }

  const alertsEl = document.getElementById("budgetAlerts");
  if (alertsEl) {
    const overBudget = STATE.budgetCategories.filter(c => categoryStatus(c) === "Over Budget");
    alertsEl.innerHTML = overBudget.length
      ? `<div class="fin-alerts">${overBudget.map(c => `<div class="fin-alert">⚠️ ${escapeHtml(c.name)} is ${fmtMoney(Math.abs(categoryVariance(c)))} over budget</div>`).join("")}</div>`
      : "";
  }

  const body = document.getElementById("budgetTableBody");
  if (body) {
    if (STATE.budgetCategories.length === 0) {
      body.innerHTML = `<tr><td colspan="9" class="empty-note">No budget categories yet. Click "+ Add Category" to create one (e.g. Framing, Plumbing, Site Rentals).</td></tr>`;
    } else {
      body.innerHTML = "";
      STATE.budgetCategories.forEach(c => {
        const variance = categoryVariance(c);
        const status = categoryStatus(c);
        const tr = document.createElement("tr");
        tr.className = "clickable";
        tr.onclick = () => openBudgetModal(c.id);
        tr.innerHTML = `
          <td>${escapeHtml(c.name)}</td>
          <td class="num">${fmtMoney(c.budgetAmount)}</td>
          <td class="num">${fmtMoney(categoryCommitted(c))}</td>
          <td class="num">${fmtMoney(categoryInvoiced(c))}</td>
          <td class="num">${fmtMoney(categoryPaid(c))}</td>
          <td class="num">${fmtMoney(categoryActual(c))}</td>
          <td class="num ${variance < 0 ? "red" : "green"}">${fmtMoney(variance)}</td>
          <td class="num ${variance < 0 ? "red" : "green"}">${fmtPct(categoryVariancePct(c))}</td>
          <td><span class="status-pill ${categoryStatusClass(status)}">${status}</span></td>
        `;
        body.appendChild(tr);
      });
    }
  }
}

function tradeCheckboxesHtml(selectedIds) {
  const sel = selectedIds || [];
  if (STATE.trades.length === 0) return `<div class="empty-note">No trades yet — add a trade first, then link it here.</div>`;
  return STATE.trades.map(t => `
    <label class="checkbox-row">
      <input type="checkbox" class="bcTradeCheck" value="${escapeAttr(t.tradeId)}" ${sel.includes(t.tradeId) ? "checked" : ""}>
      <span>${escapeHtml(t.tradeName)}${t.category === "Site Rentals" ? " (Site Rentals)" : ""}</span>
    </label>
  `).join("");
}

function getOpenBudgetCategory() {
  return STATE.budgetCategories.find(c => c.id === STATE.openBudgetCategoryId) || null;
}

function openBudgetModal(id) {
  STATE.openBudgetCategoryId = id || null;
  document.getElementById("budgetModalOverlay").classList.add("show");
  renderBudgetModal();
}
function closeBudgetModal() {
  document.getElementById("budgetModalOverlay").classList.remove("show");
  STATE.openBudgetCategoryId = null;
}

function renderBudgetModal() {
  const c = getOpenBudgetCategory();
  const isNew = !c;
  document.getElementById("budgetModalTitle").textContent = isNew ? "Add Budget Category" : c.name;
  const basis = actualExpenseBasis();

  const body = document.getElementById("budgetModalBody");
  body.innerHTML = `
    <div class="fin-section">
      <div class="field"><label>Category *</label><input type="text" id="bcName" value="${c ? escapeHtml(c.name) : ""}" placeholder="e.g. Framing, Site Rentals, Permits"></div>
      <div class="field"><label>Budget Amount</label><input type="number" id="bcBudget" min="0" step="1" value="${c ? c.budgetAmount : ""}"></div>
      <div class="field">
        <label>Linked Trades (committed / invoiced / paid roll up from these)</label>
        <div class="checkbox-list">${tradeCheckboxesHtml(c ? c.tradeIds : [])}</div>
      </div>
      ${basis === "Manual" ? `<div class="field"><label>Manually Entered Actual</label><input type="number" id="bcManualActual" min="0" step="1" value="${c && c.manualActual !== null ? c.manualActual : ""}"></div>` : ""}
      <div class="field"><label>Notes</label><textarea id="bcNotes">${c ? escapeHtml(c.notes) : ""}</textarea></div>
      <div class="modal-error" id="bcError"></div>
      <button class="btn primary admin-only" id="btnSaveBudgetCategory">${isNew ? "Add Category" : "Save Changes"}</button>
    </div>
    ${c ? `
    <div class="fin-section">
      <div class="fin-section-title">Live Totals (${basis === "Manual" ? "Manually Entered" : basis === "Paid" ? "Paid Amount" : "Invoice Amount"} basis)</div>
      <div class="fin-grid">
        <div class="fin-stat"><div class="fin-stat-label">Committed</div><div class="fin-stat-val">${fmtMoney(categoryCommitted(c))}</div></div>
        <div class="fin-stat"><div class="fin-stat-label">Invoiced</div><div class="fin-stat-val">${fmtMoney(categoryInvoiced(c))}</div></div>
        <div class="fin-stat"><div class="fin-stat-label">Paid</div><div class="fin-stat-val">${fmtMoney(categoryPaid(c))}</div></div>
        <div class="fin-stat"><div class="fin-stat-label">Variance</div><div class="fin-stat-val">${fmtMoney(categoryVariance(c))}</div></div>
      </div>
    </div>
    <div class="fin-section">
      <button class="link-btn danger admin-only" id="btnDeleteBudgetCategory">Remove this budget category</button>
    </div>
    ` : ""}
  `;

  document.getElementById("btnSaveBudgetCategory").onclick = saveBudgetModal;
  const delBtn = document.getElementById("btnDeleteBudgetCategory");
  if (delBtn) delBtn.onclick = () => deleteBudgetCategory(c.id);
}

function saveBudgetModal() {
  const errEl = document.getElementById("bcError");
  const name = document.getElementById("bcName").value.trim();
  if (!name) { errEl.textContent = "Category name is required."; return; }
  const budgetAmount = Number(document.getElementById("bcBudget").value) || 0;
  const tradeIds = Array.from(document.querySelectorAll(".bcTradeCheck:checked")).map(cb => cb.value);
  const manualActualEl = document.getElementById("bcManualActual");
  const manualActual = manualActualEl ? (manualActualEl.value === "" ? null : Number(manualActualEl.value)) : (getOpenBudgetCategory() ? getOpenBudgetCategory().manualActual : null);
  const notes = document.getElementById("bcNotes").value.trim();

  let c = getOpenBudgetCategory();
  if (!c) {
    c = { id: nextBudgetCategoryId(), name, budgetAmount, tradeIds, manualActual, notes };
    STATE.budgetCategories.push(c);
    logActivity(`Budget category added: ${name} (${fmtMoney(budgetAmount)}).`);
    STATE.openBudgetCategoryId = c.id;
  } else {
    const nameChanged = c.name !== name;
    c.name = name; c.budgetAmount = budgetAmount; c.tradeIds = tradeIds; c.manualActual = manualActual; c.notes = notes;
    logActivity(nameChanged ? `Budget category renamed to: ${name}.` : `Budget category updated: ${name}.`);
  }
  STATE.lastUpdated = new Date();
  firebaseSave();
  renderAll();
  renderBudgetModal();
}

function deleteBudgetCategory(id) {
  const c = STATE.budgetCategories.find(x => x.id === id);
  if (!c) return;
  if (!confirm(`Remove budget category "${c.name}"? This can't be undone. (Its linked trades and their financial history are NOT affected.)`)) return;
  STATE.budgetCategories = STATE.budgetCategories.filter(x => x.id !== id);
  STATE.lastUpdated = new Date();
  logActivity(`Budget category removed: ${c.name}.`);
  firebaseSave();
  closeBudgetModal();
  renderAll();
}

/* ============================================================
   MODAL — VIEW / EDIT MILESTONE
   ============================================================ */

let MODAL_REVEAL_PAYMENT = false;

function openModal(id, tab) {
  STATE.openMilestoneId = id;
  MODAL_REVEAL_PAYMENT = false;
  const m = STATE.milestones.find(x => x.id === id);
  const sched = CACHED_SCHEDULE[id];
  const overlay = document.getElementById("modalOverlay");
  overlay.classList.add("show");

  document.getElementById("modalTitle").textContent = m.name;
  document.getElementById("mDescription").value = m.description || "";
  document.getElementById("mStart").value = isoDate(sched.start);
  document.getElementById("mFinishDisplay").textContent = fmtDate(sched.finish);
  document.getElementById("mDuration").value = m.duration;
  document.getElementById("mStatus").value = m.status;
  document.getElementById("mProgress").value = m.progress;
  document.getElementById("mProgressLabel").textContent = m.progress + "%";
  document.getElementById("mPriority").value = m.priority || "Normal";
  document.getElementById("mTrade").value = m.trade;
  document.getElementById("mNotes").value = m.notes;
  document.getElementById("mDependency").textContent = ((m.dependency || []).length
    ? m.dependency.map(id2 => STATE.milestones.find(x => x.id === id2)?.name).filter(Boolean).join(", ")
    : "None — starts at project start");
  document.getElementById("mError").textContent = "";

  // Client view: fields are informational only, not editable
  const editable = USER_ROLE === "admin";
  ["mDescription", "mStart", "mDuration", "mStatus", "mProgress", "mPriority", "mTrade", "mNotes"].forEach(fid => {
    document.getElementById(fid).disabled = !editable;
  });

  renderMilestoneTradesTab(m);
  renderMilestoneGallery(m.id);
  switchModalTab(tab === "financials" ? "financials" : (tab === "gallery" ? "gallery" : "schedule"));
}

function switchModalTab(tab) {
  const schedBtn = document.getElementById("tabBtnSchedule");
  const finBtn = document.getElementById("tabBtnFinancials");
  const galBtn = document.getElementById("tabBtnGallery");
  const schedBody = document.getElementById("scheduleTabContent");
  const finBody = document.getElementById("financialsTabContent");
  const galBody = document.getElementById("galleryTabContent");
  const schedFoot = document.getElementById("scheduleModalFoot");
  [schedBtn, finBtn, galBtn].forEach(b => b.classList.remove("active"));
  [schedBody, finBody, galBody].forEach(b => b.style.display = "none");
  if (tab === "financials") {
    finBtn.classList.add("active"); finBody.style.display = "block"; schedFoot.style.display = "none";
  } else if (tab === "gallery") {
    galBtn.classList.add("active"); galBody.style.display = "block"; schedFoot.style.display = "none";
  } else {
    schedBtn.classList.add("active"); schedBody.style.display = "flex"; schedFoot.style.display = "flex";
  }
}

function closeModal() {
  document.getElementById("modalOverlay").classList.remove("show");
  STATE.openMilestoneId = null;
}

function saveModal() {
  if (USER_ROLE !== "admin") return; // client can't save; button is hidden too
  const id = STATE.openMilestoneId;
  const m = STATE.milestones.find(x => x.id === id);
  const errEl = document.getElementById("mError");

  const newDescription = document.getElementById("mDescription").value.trim();
  const newDuration = parseInt(document.getElementById("mDuration").value, 10);
  const newStatus = document.getElementById("mStatus").value;
  const newProgress = parseInt(document.getElementById("mProgress").value, 10);
  const newPriority = document.getElementById("mPriority").value;
  const newTrade = document.getElementById("mTrade").value.trim();
  const newNotes = document.getElementById("mNotes").value.trim();
  const newStartRaw = document.getElementById("mStart").value;

  if (!newDuration || newDuration < 1) { errEl.textContent = "Duration must be at least 1 business day."; return; }
  if (newProgress < 0 || newProgress > 100 || isNaN(newProgress)) { errEl.textContent = "Progress must be between 0 and 100."; return; }
  if (!newStartRaw) { errEl.textContent = "Start date is required."; return; }

  const oldStartISO = isoDate(CACHED_SCHEDULE[id].start);
  const manualOverride = newStartRaw !== oldStartISO ? newStartRaw : m.manualStart;

  const changes = [];
  if (m.duration !== newDuration) changes.push(`duration ${m.duration}d → ${newDuration}d`);
  if (m.status !== newStatus) changes.push(`status "${m.status}" → "${newStatus}"`);
  if (m.progress !== newProgress) changes.push(`progress ${m.progress}% → ${newProgress}%`);
  if (m.trade !== newTrade) changes.push(`trade reassigned`);
  if (newStartRaw !== oldStartISO) changes.push(`start moved to ${newStartRaw}`);

  m.description = newDescription;
  m.duration = newDuration;
  m.status = newStatus;
  m.progress = newProgress;
  m.priority = newPriority;
  m.trade = newTrade;
  m.notes = newNotes;
  m.manualStart = manualOverride;

  STATE.lastUpdated = new Date();
  if (changes.length) {
    logActivity(`${m.name}: ${changes.join(", ")}`);
    const oldProjected = getProjectedCompletion(CACHED_SCHEDULE);
    const newSchedule = computeSchedule(STATE.milestones, STATE.holidays, PROJECT.start);
    const newProjected = getProjectedCompletion(newSchedule);
    if (oldProjected && newProjected && isoDate(oldProjected) !== isoDate(newProjected)) {
      const delta = calculateBusinessDays(oldProjected, newProjected);
      logActivity(`Schedule impact: ${delta > 0 ? "+" : ""}${delta} business days — projected completion moved from ${fmtDate(oldProjected)} to ${fmtDate(newProjected)}`);
    }
  } else {
    logActivity(`${m.name}: notes updated`);
  }

  closeModal();
  firebaseSave();
  renderAll();
}

function clearManualStart() {
  const id = STATE.openMilestoneId;
  const m = STATE.milestones.find(x => x.id === id);
  m.manualStart = null;
  STATE.lastUpdated = new Date();
  logActivity(`${m.name}: start date reset to dependency-calculated date`);
  firebaseSave();
  renderAll();
  openModal(id);
}

/* ============================================================
   MILESTONE MODAL — "Trades" tab (read-mostly link view)
   ============================================================ */

function renderMilestoneTradesTab(m) {
  const el = document.getElementById("financialsTabContent");
  const linked = tradesForMilestone(m.id);
  const rows = linked.length
    ? linked.map(t => {
        const status = tradePaymentStatus(t);
        return `
      <div class="fin-list-item clickable-item" data-taction="open-linked" data-tid="${t.tradeId}">
        <div class="fin-list-item-top">
          <strong>${escapeHtml(t.tradeName)}</strong>
          <span class="status-pill ${statusPillClass(status)}">${status}</span>
        </div>
        <div class="fin-list-item-meta">${escapeHtml(t.vendor) || "No vendor set"} · ${fmtMoney(revisedContractValue(t))} contract</div>
      </div>`;
      }).join("")
    : `<div class="empty-note">No trades linked to this milestone yet.</div>`;

  el.innerHTML = `
    <div class="fin-section">
      <div class="fin-section-title">Trades linked to "${escapeHtml(m.name)}"</div>
      ${rows}
      <button class="btn primary admin-only" style="margin-top:8px;" data-taction="add-linked">+ Add Trade for ${escapeHtml(m.name)}</button>
      <div class="fin-note">Trades are managed independently in the Trade Costs section below the timeline — this is just a quick link. Adding or removing a trade here never changes this milestone's schedule.</div>
    </div>
  `;
  el.onclick = (e) => {
    const item = e.target.closest("[data-taction]");
    if (!item) return;
    if (item.dataset.taction === "open-linked") openTradeModal(item.dataset.tid);
    if (item.dataset.taction === "add-linked" && USER_ROLE === "admin") { closeModal(); openTradeModal(null, m.id); }
  };
}

/* ============================================================
   IMAGE HANDLING — client-side compression before persisting.
   Photos/logos are stored as compressed base64 data URLs directly
   in the Realtime Database (Firebase Storage needs the Blaze plan
   — see README). Compressing client-side keeps each record small
   enough to be a reasonable RTDB write. Two sizes are generated:
   a small thumbnail for grids and a larger version for the
   lightbox / logo display.
   ============================================================ */

const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // 15MB raw-file ceiling before we even try to compress

function validateImageFile(file) {
  if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
    return `"${file.name}" isn't a supported image type. Please use JPG, PNG, or WEBP.`;
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return `"${file.name}" is too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Please use a file under 15MB.`;
  }
  return null;
}

// Resizes/compresses an image file to a max dimension + JPEG quality,
// returning a base64 data URL. Used for both the full-size gallery
// image and its thumbnail (called twice with different maxDim).
function compressImageToDataUrl(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Couldn't read the file."));
    reader.onload = () => {
      img.onerror = () => reject(new Error("Couldn't load the image — it may be corrupted."));
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width >= height) { height = Math.round(height * (maxDim / width)); width = maxDim; }
          else { width = Math.round(width * (maxDim / height)); height = maxDim; }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/* ============================================================
   MILESTONE GALLERY
   ============================================================ */

function renderMilestoneGallery(milestoneId) {
  const m = STATE.milestones.find(x => x.id === milestoneId);
  const el = document.getElementById("galleryTabContent");
  if (!m) { el.innerHTML = ""; return; }
  const photos = m.gallery || [];

  el.innerHTML = `
    <div class="gallery-toolbar">
      <div class="fin-section-title" style="margin:0;">Photos (${photos.length})</div>
      <button class="btn primary admin-only" id="btnAddGalleryPhotos">+ Add Photos</button>
    </div>
    <div class="gallery-upload-progress" id="galleryUploadProgress"></div>
    <div class="gallery-grid" id="galleryGrid">
      ${photos.length ? photos.map((p, i) => `
        <div class="gallery-thumb" data-idx="${i}">
          <img src="${p.thumbDataUrl || p.dataUrl}" alt="${escapeHtml(p.caption || p.fileName || "")}" loading="lazy">
          ${p.caption ? `<div class="gallery-caption-chip">${escapeHtml(p.caption)}</div>` : ""}
          <div class="gallery-admin-controls admin-only">
            <button data-gaction="caption" data-idx="${i}" title="Edit caption">✎</button>
            <button data-gaction="delete" data-idx="${i}" title="Delete">×</button>
          </div>
        </div>
      `).join("") : `<div class="gallery-empty">No photos yet${USER_ROLE === "admin" ? " — click \u201c+ Add Photos\u201d to upload some." : "."}</div>`}
    </div>
  `;

  document.getElementById("btnAddGalleryPhotos").onclick = () => {
    if (USER_ROLE !== "admin") return;
    document.getElementById("galleryFileInput").click();
  };

  document.getElementById("galleryGrid").onclick = (e) => {
    const ctrl = e.target.closest("[data-gaction]");
    if (ctrl) {
      const idx = parseInt(ctrl.dataset.idx, 10);
      if (ctrl.dataset.gaction === "delete") deleteGalleryPhoto(milestoneId, idx);
      if (ctrl.dataset.gaction === "caption") editGalleryCaption(milestoneId, idx);
      return;
    }
    const thumb = e.target.closest(".gallery-thumb");
    if (thumb) openLightbox(milestoneId, parseInt(thumb.dataset.idx, 10));
  };
}

function handleGalleryFileUpload(files) {
  if (USER_ROLE !== "admin") return;
  const id = STATE.openMilestoneId;
  const m = STATE.milestones.find(x => x.id === id);
  if (!m) return;
  const fileArr = Array.from(files);
  const progressEl = document.getElementById("galleryUploadProgress");

  const errors = [];
  const valid = fileArr.filter(f => {
    const err = validateImageFile(f);
    if (err) { errors.push(err); return false; }
    return true;
  });
  if (errors.length) alert(errors.join("\n"));
  if (!valid.length) return;

  if (progressEl) progressEl.textContent = `Uploading 0 / ${valid.length}…`;
  let done = 0;

  Promise.all(valid.map(file =>
    Promise.all([
      compressImageToDataUrl(file, 1600, 0.75),
      compressImageToDataUrl(file, 320, 0.7),
    ]).then(([dataUrl, thumbDataUrl]) => {
      done++;
      if (progressEl) progressEl.textContent = `Uploading ${done} / ${valid.length}…`;
      return {
        id: "PHOTO-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7),
        dataUrl, thumbDataUrl,
        fileName: file.name,
        caption: "",
        date: isoDate(new Date()),
        uploadedAt: new Date().toISOString(),
        uploadedBy: (CURRENT_USER && CURRENT_USER.email) || "Admin",
      };
    }).catch(err => {
      errors.push(`"${file.name}" failed to process: ${err.message}`);
      return null;
    })
  )).then(results => {
    const newPhotos = results.filter(Boolean);
    if (newPhotos.length) {
      m.gallery = (m.gallery || []).concat(newPhotos);
      STATE.lastUpdated = new Date();
      logActivity(`${newPhotos.length} photo${newPhotos.length === 1 ? "" : "s"} added to "${m.name}".`);
      firebaseSave();
      renderMilestoneGallery(id);
      renderAll();
    }
    if (progressEl) progressEl.textContent = "";
    if (errors.length) alert(errors.join("\n"));
  });
}

function deleteGalleryPhoto(milestoneId, idx) {
  if (USER_ROLE !== "admin") return;
  const m = STATE.milestones.find(x => x.id === milestoneId);
  if (!m || !m.gallery || !m.gallery[idx]) return;
  if (!confirm("Delete this photo? This can't be undone.")) return;
  const removed = m.gallery.splice(idx, 1)[0];
  STATE.lastUpdated = new Date();
  logActivity(`Photo removed from "${m.name}"${removed.caption ? ` ("${removed.caption}")` : ""}.`);
  firebaseSave();
  renderMilestoneGallery(milestoneId);
  renderAll();
}

function editGalleryCaption(milestoneId, idx) {
  if (USER_ROLE !== "admin") return;
  const m = STATE.milestones.find(x => x.id === milestoneId);
  if (!m || !m.gallery || !m.gallery[idx]) return;
  const photo = m.gallery[idx];
  const newCaption = prompt("Caption for this photo:", photo.caption || "");
  if (newCaption === null) return; // cancelled
  photo.caption = newCaption.trim();
  STATE.lastUpdated = new Date();
  logActivity(`Photo caption updated on "${m.name}".`);
  firebaseSave();
  renderMilestoneGallery(milestoneId);
}

/* ---------- Lightbox (viewer for both admin and client) ---------- */

function openLightbox(milestoneId, index) {
  STATE.galleryLightbox = { milestoneId, index };
  renderLightbox();
  document.getElementById("lightboxOverlay").classList.add("show");
}

function closeLightbox() {
  document.getElementById("lightboxOverlay").classList.remove("show");
}

function renderLightbox() {
  const { milestoneId, index } = STATE.galleryLightbox;
  const m = STATE.milestones.find(x => x.id === milestoneId);
  if (!m || !m.gallery || !m.gallery.length) { closeLightbox(); return; }
  const photo = m.gallery[index];
  if (!photo) return;
  document.getElementById("lightboxImg").src = photo.dataUrl;
  document.getElementById("lightboxCaption").textContent = [photo.caption, photo.date ? fmtDate(parseISO(photo.date)) : null].filter(Boolean).join(" · ");
}

function lightboxNav(delta) {
  const { milestoneId, index } = STATE.galleryLightbox;
  const m = STATE.milestones.find(x => x.id === milestoneId);
  if (!m || !m.gallery || !m.gallery.length) return;
  const next = (index + delta + m.gallery.length) % m.gallery.length;
  STATE.galleryLightbox.index = next;
  renderLightbox();
}

/* ============================================================
   TRADE MODAL — add / edit / archive / delete a trade
   ============================================================ */

let TRADE_REVEAL = false; // reserved for future sensitive-field masking on trades

function openTradeModal(tradeId, presetMilestoneId) {
  STATE.openTradeId = tradeId || null;
  const overlay = document.getElementById("tradeModalOverlay");
  overlay.classList.add("show");
  renderTradeModal(presetMilestoneId);
}

function closeTradeModal() {
  document.getElementById("tradeModalOverlay").classList.remove("show");
  STATE.openTradeId = null;
}

function getOpenTrade() {
  return STATE.trades.find(t => t.tradeId === STATE.openTradeId) || null;
}

function milestoneCheckboxesHtml(selectedIds) {
  const sel = selectedIds || [];
  return STATE.milestones.map(m => `
    <label class="checkbox-row">
      <input type="checkbox" class="tMilestoneCheck" value="${m.id}" ${sel.includes(m.id) ? "checked" : ""}>
      <span>${escapeHtml(m.name)}</span>
    </label>
  `).join("");
}

function renderTradeModal(presetMilestoneId) {
  const t = getOpenTrade();
  const isNew = !t;
  const body = document.getElementById("tradeModalBody");
  const title = document.getElementById("tradeModalTitle");
  title.textContent = isNew ? "Add Trade" : t.tradeName;

  const changeOrdersHtml = t && (t.changeOrders || []).length
    ? t.changeOrders.map(c => `
      <div class="fin-list-item">
        <div class="fin-list-item-top">
          <strong>${escapeHtml(c.description) || "Change order"}</strong>
          <span class="status-pill ${statusPillClass(c.status)}">${c.status}</span>
        </div>
        <div class="fin-list-item-meta">${c.date ? fmtDate(parseISO(c.date)) : "No date"} · ${fmtMoney(c.amount)}${c.approvedBy ? " · Approved by " + escapeHtml(c.approvedBy) : ""}</div>
        <div class="fin-list-actions">
          <select class="admin-only" data-caction="co-status" data-id="${c.changeOrderId}">
            <option value="Pending" ${c.status === "Pending" ? "selected" : ""}>Pending</option>
            <option value="Approved" ${c.status === "Approved" ? "selected" : ""}>Approved</option>
            <option value="Rejected" ${c.status === "Rejected" ? "selected" : ""}>Rejected</option>
          </select>
          <button class="danger admin-only" data-caction="co-delete" data-id="${c.changeOrderId}">Delete</button>
        </div>
      </div>`).join("")
    : `<div class="empty-note">No change orders yet.</div>`;

  const invoicesHtml = t && (t.invoices || []).length
    ? t.invoices.map(inv => {
        const bal = invoiceBalance(t, inv);
        const overdue = invoiceOverdue(t, inv);
        const dispStatus = overdue ? "Overdue" : (bal <= 0 ? "Paid" : (bal < inv.total ? "Partially Paid" : "Unpaid"));
        const hasLocalFile = !!LOCAL_INVOICE_FILES[inv.invoiceId];
        return `
      <div class="fin-list-item">
        <div class="fin-list-item-top">
          <strong>${escapeHtml(inv.invoiceNumber) || "Invoice"}</strong>
          <span class="status-pill ${statusPillClass(dispStatus)}">${dispStatus}</span>
        </div>
        <div class="fin-list-item-meta">${escapeHtml(inv.vendor) || t.vendor || ""} · ${fmtMoney(inv.total)}${inv.dueDate ? " · Due " + fmtDate(parseISO(inv.dueDate)) : ""} · Balance ${fmtMoney(bal)}</div>
        <div class="fin-list-item-meta">${inv.fileName ? "📎 " + escapeHtml(inv.fileName) + (hasLocalFile ? "" : " (preview not available in this session)") : "No file attached"}</div>
        <div class="fin-list-actions">
          ${hasLocalFile ? `<button data-caction="inv-view" data-id="${inv.invoiceId}">View</button><button data-caction="inv-download" data-id="${inv.invoiceId}">Download</button>` : ""}
          <button class="admin-only" data-caction="inv-attach" data-id="${inv.invoiceId}">${inv.fileName ? "Replace file" : "Attach PDF"}</button>
          <button class="danger admin-only" data-caction="inv-delete" data-id="${inv.invoiceId}">Delete</button>
        </div>
      </div>`;
      }).join("")
    : `<div class="empty-note">No invoices yet.</div>`;

  const paymentsHtml = t && (t.payments || []).length
    ? t.payments.map(p => {
        const inv = (t.invoices || []).find(i => i.invoiceId === p.invoiceId);
        return `
      <div class="fin-list-item">
        <div class="fin-list-item-top">
          <strong>${fmtMoney(p.amount)}</strong>
          <span class="fin-list-item-meta">${p.date ? fmtDate(parseISO(p.date)) : "No date"}</span>
        </div>
        <div class="fin-list-item-meta">${inv ? "Applied to " + escapeHtml(inv.invoiceNumber) : "Not linked to an invoice"}${p.method ? " · " + escapeHtml(p.method) : ""}${p.reference ? " · Ref " + escapeHtml(p.reference) : ""}</div>
        ${p.notes ? `<div class="fin-list-item-meta">${escapeHtml(p.notes)}</div>` : ""}
        <div class="fin-list-actions">
          <button class="danger admin-only" data-caction="pay-delete" data-id="${p.paymentId}">Delete</button>
        </div>
      </div>`;
      }).join("")
    : `<div class="empty-note">No payments recorded yet.</div>`;

  const invoiceOptionsForPayment = t
    ? `<option value="">— Not linked to an invoice —</option>` + t.invoices.map(inv => `<option value="${inv.invoiceId}">${escapeHtml(inv.invoiceNumber)} (${fmtMoney(invoiceBalance(t, inv))} owing)</option>`).join("")
    : "";

  const summaryBlock = t ? `
    <div class="fin-grid">
      <div class="fin-stat"><div class="fin-stat-label">Revised Contract</div><div class="fin-stat-val">${fmtMoney(revisedContractValue(t))}</div></div>
      <div class="fin-stat"><div class="fin-stat-label">Total Invoiced</div><div class="fin-stat-val">${fmtMoney(tradeTotalInvoiced(t))}</div></div>
      <div class="fin-stat"><div class="fin-stat-label">Total Paid</div><div class="fin-stat-val">${fmtMoney(tradeTotalPaid(t))}</div></div>
      <div class="fin-stat"><div class="fin-stat-label">Outstanding</div><div class="fin-stat-val">${fmtMoney(tradeOutstanding(t))}</div></div>
    </div>
    <div class="fin-stat" style="margin-bottom:16px;"><div class="fin-stat-label">Payment Status</div><div class="fin-stat-val"><span class="status-pill ${statusPillClass(tradePaymentStatus(t))}">${tradePaymentStatus(t)}</span></div></div>
  ` : "";

  body.innerHTML = `
    <div class="fin-section">
      <div class="fin-section-title">Trade Details ${t ? `<span class="trade-id-tag">${t.tradeId}</span>` : ""}</div>
      <div class="field"><label>Trade Name *</label><input type="text" id="tName" value="${t ? escapeHtml(t.tradeName) : ""}" placeholder="e.g. Roofing"></div>
      <div class="field-row">
        <div class="field"><label>Vendor / Contractor</label><input type="text" id="tVendor" value="${t ? escapeHtml(t.vendor) : ""}"></div>
        <div class="field"><label>Scope of Work</label><input type="text" id="tScope" value="${t ? escapeHtml(t.scope) : ""}"></div>
      </div>
      <div class="field">
        <label>Category</label>
        <select id="tCategory">
          ${["Trade", "Site Rentals", "Other"].map(c => `<option ${(t ? t.category : "Trade") === c ? "selected" : ""}>${c}</option>`).join("")}
        </select>
      </div>
      <div class="field">
        <label>Milestones (a trade can link to more than one)</label>
        <div class="checkbox-list">${milestoneCheckboxesHtml(t ? t.milestoneIds : (presetMilestoneId !== undefined && presetMilestoneId !== null ? [presetMilestoneId] : []))}</div>
      </div>
      <div class="field-row">
        <div class="field"><label>Contract Amount</label><input type="number" id="tContract" min="0" step="1" value="${t ? t.contractAmount : ""}"></div>
        <div class="field"><label>HST</label><input type="number" id="tHst" min="0" step="1" value="${t ? t.hst : ""}"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Payment Terms</label><input type="text" id="tTerms" value="${t ? escapeHtml(t.paymentTerms) : ""}" placeholder="e.g. Net 30"></div>
        <div class="field"><label>PO Number</label><input type="text" id="tPo" value="${t ? escapeHtml(t.poNumber) : ""}"></div>
      </div>
      <div class="field">
        <label>Status</label>
        <select id="tWorkStatus">${WORK_STATUS_OPTIONS.map(s => `<option ${t && t.workStatus === s ? "selected" : ""}>${s}</option>`).join("")}</select>
      </div>
      <div class="field"><label>Notes</label><textarea id="tNotes">${t ? escapeHtml(t.notes) : ""}</textarea></div>
      <div class="modal-error" id="tError"></div>
      <button class="btn primary admin-only" data-taction="save">${isNew ? "Save Trade" : "Save Changes"}</button>
    </div>

    ${t ? `
    <div class="fin-section">
      ${summaryBlock}
    </div>

    <div class="fin-section">
      <div class="fin-section-title">Change Orders</div>
      ${changeOrdersHtml}
      <div class="fin-add-form">
        <div class="field"><label>Description</label><input type="text" id="coDescription"></div>
        <div class="field-row">
          <div class="field"><label>Date</label><input type="date" id="coDate"></div>
          <div class="field"><label>Amount</label><input type="number" id="coAmount" min="0" step="1"></div>
        </div>
        <div class="field-row">
          <div class="field"><label>Approved By</label><input type="text" id="coApprovedBy"></div>
          <div class="field"><label>Status</label><select id="coStatus"><option>Pending</option><option>Approved</option><option>Rejected</option></select></div>
        </div>
        <div class="field"><label>Notes</label><textarea id="coNotes"></textarea></div>
        <button class="btn admin-only" data-taction="co-add">Add Change Order</button>
      </div>
    </div>

    <div class="fin-section">
      <div class="fin-section-title">Invoices</div>
      ${invoicesHtml}
      <div class="fin-add-form">
        <div class="fin-dropzone" id="invDropzone">
          Drag &amp; drop a PDF here, or <span style="color:var(--accent); font-weight:600;">browse files</span>
          <input type="file" id="invFileInput" accept="application/pdf" style="display:none;">
        </div>
        <div class="fin-note" id="invFileStatus" style="display:none;"></div>
        <div class="field-row">
          <div class="field"><label>Invoice Number</label><input type="text" id="invNumber"></div>
          <div class="field"><label>Vendor</label><input type="text" id="invVendor" value="${escapeHtml(t.vendor)}"></div>
        </div>
        <div class="field-row">
          <div class="field"><label>Invoice Date</label><input type="date" id="invDate"></div>
          <div class="field"><label>Due Date</label><input type="date" id="invDue"></div>
        </div>
        <div class="field-row">
          <div class="field"><label>Subtotal</label><input type="number" id="invSubtotal" min="0" step="1"></div>
          <div class="field"><label>HST</label><input type="number" id="invHst" min="0" step="1"></div>
        </div>
        <div class="field"><label>Total (subtotal + HST)</label><div class="dep-static" id="invTotalDisplay">$0</div></div>
        <div class="field"><label>Notes</label><textarea id="invNotes"></textarea></div>
        <button class="btn admin-only" data-taction="inv-add">Add Invoice</button>
      </div>
    </div>

    <div class="fin-section">
      <div class="fin-section-title">Payments</div>
      ${paymentsHtml}
      <div class="fin-add-form">
        <div class="field-row">
          <div class="field"><label>Amount</label><input type="number" id="payAmount" min="0" step="1"></div>
          <div class="field"><label>Date</label><input type="date" id="payDate"></div>
        </div>
        <div class="field"><label>Applies to Invoice</label><select id="payInvoice">${invoiceOptionsForPayment}</select></div>
        <div class="field-row">
          <div class="field"><label>Payment Method</label><input type="text" id="payMethod" placeholder="e.g. E-transfer"></div>
          <div class="field"><label>Payment Reference</label><input type="text" id="payReference"></div>
        </div>
        <div class="field"><label>Notes</label><textarea id="payNotes"></textarea></div>
        ${t.invoices.length === 0 ? `<div class="fin-note">This trade has no invoices yet — you can still record a payment, but consider adding the invoice first for a full paper trail.</div>` : ""}
        <button class="btn admin-only" data-taction="pay-add">Add Payment</button>
      </div>
    </div>

    <div class="fin-section">
      <div class="fin-section-title">Trade Status</div>
      ${t.active
        ? `<button class="btn danger" data-taction="archive-open">Archive Trade</button>`
        : `<button class="btn primary" data-taction="restore-open">Restore Trade</button>`}
      <button class="link-btn" style="margin-top:10px;" data-taction="delete-open">Permanently delete this trade instead</button>
    </div>
    ` : ""}
  `;

  wireTradeModalInputs(t);
}

function wireTradeModalInputs(t) {
  const body = document.getElementById("tradeModalBody");
  body.onclick = (e) => handleTradeModalClick(e);
  body.onchange = (e) => handleTradeModalChange(e);

  if (!t) return; // add-form only, no invoice total calc / dropzone yet

  const subtotalEl = document.getElementById("invSubtotal");
  const hstEl = document.getElementById("invHst");
  const totalDisplay = document.getElementById("invTotalDisplay");
  const updateTotal = () => {
    const val = (Number(subtotalEl.value) || 0) + (Number(hstEl.value) || 0);
    totalDisplay.textContent = fmtMoney(val);
  };
  subtotalEl.addEventListener("input", updateTotal);
  hstEl.addEventListener("input", updateTotal);

  const dropzone = document.getElementById("invDropzone");
  const fileInput = document.getElementById("invFileInput");
  const fileStatus = document.getElementById("invFileStatus");
  const showStaged = () => {
    if (PENDING_INVOICE_FILE) {
      fileStatus.style.display = "block";
      fileStatus.textContent = `Staged: ${PENDING_INVOICE_FILE.file.name} — will attach when you click "Add Invoice."`;
    } else {
      fileStatus.style.display = "none";
    }
  };
  const stageFile = (file) => {
    if (!file) return;
    if (file.type !== "application/pdf") { alert("Please choose a PDF file."); return; }
    if (PENDING_INVOICE_FILE) URL.revokeObjectURL(PENDING_INVOICE_FILE.objectUrl);
    PENDING_INVOICE_FILE = { file, objectUrl: URL.createObjectURL(file) };
    showStaged();
  };
  dropzone.onclick = () => fileInput.click();
  fileInput.onchange = (e) => stageFile(e.target.files[0]);
  dropzone.ondragover = (e) => { e.preventDefault(); dropzone.classList.add("drag-over"); };
  dropzone.ondragleave = () => dropzone.classList.remove("drag-over");
  dropzone.ondrop = (e) => { e.preventDefault(); dropzone.classList.remove("drag-over"); stageFile(e.dataTransfer.files[0]); };
  showStaged();
}

let PENDING_INVOICE_FILE = null;
let PENDING_ATTACH_INVOICE_ID = null; // when replacing/attaching a file to an existing invoice

function handleTradeModalClick(e) {
  const btn = e.target.closest("[data-taction], [data-caction]");
  if (!btn) return;
  const taction = btn.dataset.taction;
  const caction = btn.dataset.caction;
  const id = btn.dataset.id;

  if (taction === "save") return saveTradeModal();
  if (taction === "co-add") return addChangeOrder();
  if (taction === "inv-add") return addInvoice();
  if (taction === "pay-add") return addPayment();
  if (taction === "archive-open") return archiveTradePrompt(STATE.openTradeId);
  if (taction === "restore-open") return restoreTrade(STATE.openTradeId);
  if (taction === "delete-open") return deleteTradePrompt(STATE.openTradeId);

  if (caction === "co-delete") return deleteChangeOrder(id);
  if (caction === "inv-delete") return deleteInvoice(id);
  if (caction === "inv-view") return viewInvoiceFile(id);
  if (caction === "inv-download") return downloadInvoiceFile(id);
  if (caction === "inv-attach") return attachInvoiceFile(id);
  if (caction === "pay-delete") return deletePayment(id);
}

function handleTradeModalChange(e) {
  const el = e.target;
  if (el.dataset.caction === "co-status") {
    const t = getOpenTrade();
    const c = t.changeOrders.find(x => x.changeOrderId === el.dataset.id);
    if (!c) return;
    const old = c.status;
    c.status = el.value;
    STATE.lastUpdated = new Date();
    logActivity(`Trade cost updated: ${t.tradeName} (change order "${c.description || c.changeOrderId}" ${old} → ${c.status})`);
    firebaseSave();
    renderAll();
    renderTradeModal();
  }
  if (el.id === "invFileInputHidden") {
    // used by attachInvoiceFile flow
    const file = el.files[0];
    if (!file) return;
    if (file.type !== "application/pdf") { alert("Please choose a PDF file."); return; }
    const t = getOpenTrade();
    const inv = t.invoices.find(x => x.invoiceId === PENDING_ATTACH_INVOICE_ID);
    if (!inv) return;
    if (LOCAL_INVOICE_FILES[inv.invoiceId]) URL.revokeObjectURL(LOCAL_INVOICE_FILES[inv.invoiceId]);
    LOCAL_INVOICE_FILES[inv.invoiceId] = URL.createObjectURL(file);
    inv.fileName = file.name;
    STATE.lastUpdated = new Date();
    logActivity(`Invoice attached to: ${t.tradeName} (${inv.invoiceNumber})`);
    firebaseSave();
    renderAll();
    renderTradeModal();
    alert("Invoice uploaded successfully.");
  }
}

function saveTradeModal() {
  const errEl = document.getElementById("tError");
  const tradeName = document.getElementById("tName").value.trim();
  if (!tradeName) { errEl.textContent = "Trade Name is required."; return; }

  const vendor = document.getElementById("tVendor").value.trim();
  const scope = document.getElementById("tScope").value.trim();
  const category = document.getElementById("tCategory").value;
  const milestoneIds = Array.from(document.querySelectorAll(".tMilestoneCheck:checked")).map(cb => Number(cb.value));
  const contractAmount = Number(document.getElementById("tContract").value) || 0;
  const hst = Number(document.getElementById("tHst").value) || 0;
  const paymentTerms = document.getElementById("tTerms").value.trim();
  const poNumber = document.getElementById("tPo").value.trim();
  const workStatus = document.getElementById("tWorkStatus").value;
  const notes = document.getElementById("tNotes").value.trim();

  let t = getOpenTrade();
  const now = new Date().toISOString();

  if (!t) {
    t = {
      tradeId: nextTradeId(), tradeName, vendor, scope, category, milestoneIds,
      contractAmount, hst, workStatus, paymentTerms, poNumber, notes,
      active: true, createdAt: now, updatedAt: now,
      changeOrders: [], invoices: [], payments: [],
    };
    STATE.trades.push(t);
    logActivity(`New trade added: ${tradeName}${category === "Site Rentals" ? " (Site Rentals)" : ""}`);
    STATE.openTradeId = t.tradeId;
  } else {
    const nameChanged = t.tradeName !== tradeName;
    const oldName = t.tradeName;
    t.tradeName = tradeName; t.vendor = vendor; t.scope = scope; t.category = category; t.milestoneIds = milestoneIds;
    t.contractAmount = contractAmount; t.hst = hst; t.paymentTerms = paymentTerms;
    t.poNumber = poNumber; t.workStatus = workStatus; t.notes = notes;
    t.updatedAt = now;
    if (nameChanged) logActivity(`Trade name changed: ${oldName} → ${tradeName}`);
    else logActivity(`Trade cost updated: ${tradeName}`);
  }

  STATE.lastUpdated = new Date();
  firebaseSave();
  renderAll();
  renderTradeModal();
}

function addChangeOrder() {
  const t = getOpenTrade();
  const description = document.getElementById("coDescription").value.trim();
  const date = document.getElementById("coDate").value || null;
  const amount = Number(document.getElementById("coAmount").value) || 0;
  const approvedBy = document.getElementById("coApprovedBy").value.trim();
  const status = document.getElementById("coStatus").value;
  const notes = document.getElementById("coNotes").value.trim();
  if (!description) { alert("Enter a description for the change order."); return; }
  t.changeOrders.push({ changeOrderId: nextFinId(), description, date, amount, approvedBy, status, notes });
  t.updatedAt = new Date().toISOString();
  STATE.lastUpdated = new Date();
  logActivity(`Trade cost updated: ${t.tradeName} (change order added — ${description}, ${fmtMoney(amount)})`);
  firebaseSave();
  renderAll();
  renderTradeModal();
}

function deleteChangeOrder(coId) {
  const t = getOpenTrade();
  const c = t.changeOrders.find(x => x.changeOrderId === coId);
  if (!c) return;
  if (!confirm(`Delete change order "${c.description}"?`)) return;
  t.changeOrders = t.changeOrders.filter(x => x.changeOrderId !== coId);
  t.updatedAt = new Date().toISOString();
  STATE.lastUpdated = new Date();
  logActivity(`Trade cost updated: ${t.tradeName} (change order deleted — ${c.description})`);
  firebaseSave();
  renderAll();
  renderTradeModal();
}

function addInvoice() {
  const t = getOpenTrade();
  const invoiceNumber = document.getElementById("invNumber").value.trim();
  const vendor = document.getElementById("invVendor").value.trim();
  const invoiceDate = document.getElementById("invDate").value || null;
  const dueDate = document.getElementById("invDue").value || null;
  const subtotal = Number(document.getElementById("invSubtotal").value) || 0;
  const hst = Number(document.getElementById("invHst").value) || 0;
  const total = subtotal + hst;
  const notes = document.getElementById("invNotes").value.trim();
  if (!invoiceNumber) { alert("Enter an invoice number."); return; }
  if (total <= 0) { alert("Invoice total must be greater than $0."); return; }

  const invoiceId = nextFinId();
  const fileName = PENDING_INVOICE_FILE ? PENDING_INVOICE_FILE.file.name : "";
  if (PENDING_INVOICE_FILE) {
    LOCAL_INVOICE_FILES[invoiceId] = PENDING_INVOICE_FILE.objectUrl;
    PENDING_INVOICE_FILE = null;
  }
  t.invoices.push({ invoiceId, invoiceNumber, vendor, invoiceDate, dueDate, subtotal, hst, total, fileName, notes });
  t.updatedAt = new Date().toISOString();
  STATE.lastUpdated = new Date();
  logActivity(`Invoice attached to: ${t.tradeName} (${invoiceNumber}, ${fmtMoney(total)})`);
  firebaseSave();
  renderAll();
  renderTradeModal();
  if (fileName) alert("Invoice uploaded successfully.");
}

function deleteInvoice(invId) {
  const t = getOpenTrade();
  const inv = t.invoices.find(x => x.invoiceId === invId);
  if (!inv) return;
  const linkedPayments = t.payments.filter(p => p.invoiceId === invId).length;
  const warn = linkedPayments ? ` This invoice has ${linkedPayments} payment(s) recorded against it — they will stay on the trade but become unlinked.` : "";
  if (!confirm(`Delete invoice "${inv.invoiceNumber}"?${warn}`)) return;
  if (LOCAL_INVOICE_FILES[invId]) { URL.revokeObjectURL(LOCAL_INVOICE_FILES[invId]); delete LOCAL_INVOICE_FILES[invId]; }
  t.invoices = t.invoices.filter(x => x.invoiceId !== invId);
  t.payments.forEach(p => { if (p.invoiceId === invId) p.invoiceId = null; });
  t.updatedAt = new Date().toISOString();
  STATE.lastUpdated = new Date();
  logActivity(`Trade cost updated: ${t.tradeName} (invoice deleted — ${inv.invoiceNumber})`);
  firebaseSave();
  renderAll();
  renderTradeModal();
}

function attachInvoiceFile(invId) {
  PENDING_ATTACH_INVOICE_ID = invId;
  let hidden = document.getElementById("invFileInputHidden");
  if (!hidden) {
    hidden = document.createElement("input");
    hidden.type = "file";
    hidden.accept = "application/pdf";
    hidden.id = "invFileInputHidden";
    hidden.style.display = "none";
    document.getElementById("tradeModalBody").appendChild(hidden);
    hidden.addEventListener("change", handleTradeModalChange);
  }
  hidden.click();
}

function viewInvoiceFile(invId) {
  const url = LOCAL_INVOICE_FILES[invId];
  if (!url) { alert("This PDF is only available in the browser session it was uploaded in. Real file storage (OneDrive/SharePoint/Supabase) is needed to make invoices viewable everywhere."); return; }
  window.open(url, "_blank");
}

function downloadInvoiceFile(invId) {
  const t = getOpenTrade();
  const inv = t.invoices.find(x => x.invoiceId === invId);
  const url = LOCAL_INVOICE_FILES[invId];
  if (!url || !inv) { alert("This PDF is only available in the browser session it was uploaded in."); return; }
  const a = document.createElement("a");
  a.href = url; a.download = inv.fileName || "invoice.pdf";
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

function addPayment() {
  const t = getOpenTrade();
  const amount = Number(document.getElementById("payAmount").value) || 0;
  const date = document.getElementById("payDate").value || null;
  const invoiceIdRaw = document.getElementById("payInvoice").value;
  const invoiceId = invoiceIdRaw ? Number(invoiceIdRaw) : null;
  const method = document.getElementById("payMethod").value.trim();
  const reference = document.getElementById("payReference").value.trim();
  const notes = document.getElementById("payNotes").value.trim();
  if (amount <= 0) { alert("Payment amount must be greater than $0."); return; }
  if (!invoiceId && t.invoices.length > 0) {
    if (!confirm("This payment isn't linked to a specific invoice. Add it anyway?")) return;
  }
  t.payments.push({ paymentId: nextFinId(), invoiceId, amount, date, method, reference, notes });
  t.updatedAt = new Date().toISOString();
  STATE.lastUpdated = new Date();
  logActivity(`Payment added to: ${t.tradeName} (${fmtMoney(amount)})`);
  firebaseSave();
  renderAll();
  renderTradeModal();
}

function deletePayment(payId) {
  const t = getOpenTrade();
  const p = t.payments.find(x => x.paymentId === payId);
  if (!p) return;
  if (!confirm(`Delete this ${fmtMoney(p.amount)} payment?`)) return;
  t.payments = t.payments.filter(x => x.paymentId !== payId);
  t.updatedAt = new Date().toISOString();
  STATE.lastUpdated = new Date();
  logActivity(`Trade cost updated: ${t.tradeName} (payment deleted — ${fmtMoney(p.amount)})`);
  firebaseSave();
  renderAll();
  renderTradeModal();
}

/* ============================================================
   ARCHIVE / RESTORE / DELETE TRADE
   ============================================================ */

function archiveTradePrompt(tradeId) {
  const t = STATE.trades.find(x => x.tradeId === tradeId);
  if (!t) return;
  openRemoveTradeModal(t);
}

function deleteTradePrompt(tradeId) {
  const t = STATE.trades.find(x => x.tradeId === tradeId);
  if (!t) return;
  openRemoveTradeModal(t, true);
}

function hasFinancialHistory(t) {
  return (t.invoices || []).length > 0 || (t.payments || []).length > 0 || (t.changeOrders || []).length > 0;
}

function openRemoveTradeModal(t, forceDeleteView) {
  const overlay = document.getElementById("removeTradeOverlay");
  const body = document.getElementById("removeTradeBody");
  overlay.classList.add("show");
  overlay.dataset.tid = t.tradeId;

  const hasHistory = hasFinancialHistory(t);
  const showDelete = forceDeleteView || !hasHistory;

  const summary = `
    <div class="fin-stat" style="margin-bottom:14px;">
      <div class="fin-stat-label">Trade</div>
      <div class="fin-stat-val" style="font-size:15px;">${escapeHtml(t.tradeName)}</div>
    </div>
    <div class="fin-grid">
      <div class="fin-stat"><div class="fin-stat-label">Contract Amount</div><div class="fin-stat-val">${fmtMoney(revisedContractValue(t))}</div></div>
      <div class="fin-stat"><div class="fin-stat-label">Invoices</div><div class="fin-stat-val">${(t.invoices || []).length}</div></div>
      <div class="fin-stat"><div class="fin-stat-label">Payments</div><div class="fin-stat-val">${(t.payments || []).length}</div></div>
      <div class="fin-stat"><div class="fin-stat-label">Change Orders</div><div class="fin-stat-val">${(t.changeOrders || []).length}</div></div>
    </div>
  `;

  if (!showDelete) {
    body.innerHTML = `
      <p>Remove this trade?</p>
      ${summary}
      <div class="fin-note">This trade has financial history, so it will be <strong>archived</strong> instead of deleted — its invoices, payments, and change orders stay fully intact and accessible, and you can restore it any time from the "Archived" filter.</div>
      <div class="modal-foot" style="padding:16px 0 0; border-top:none;">
        <button class="btn" data-raction="cancel">Cancel</button>
        <button class="btn primary" data-raction="archive">Archive Trade</button>
      </div>
    `;
  } else {
    body.innerHTML = `
      <p>${hasHistory ? `This trade has ${(t.invoices||[]).length} invoice(s) and ${(t.payments||[]).length} payment(s). Permanently deleting it will remove its associated records.` : "Remove this trade permanently? This cannot be undone."}</p>
      ${summary}
      ${hasHistory ? `
      <div class="field">
        <label>Type DELETE to confirm permanent deletion</label>
        <input type="text" id="deleteConfirmInput" placeholder="DELETE">
      </div>` : ""}
      <div class="modal-foot" style="padding:16px 0 0; border-top:none;">
        <button class="btn" data-raction="cancel">Cancel</button>
        ${hasHistory ? `<button class="btn" data-raction="archive">Archive Instead</button>` : ""}
        <button class="btn danger admin-only" data-raction="delete-confirm">Permanently Delete</button>
      </div>
    `;
  }

  body.onclick = (e) => {
    const btn = e.target.closest("[data-raction]");
    if (!btn) return;
    const action = btn.dataset.raction;
    if (action === "cancel") return closeRemoveTradeModal();
    if (action === "archive") return doArchiveTrade(t.tradeId);
    if (action === "delete-confirm") {
      if (hasHistory) {
        const input = document.getElementById("deleteConfirmInput");
        if (!input || input.value.trim().toUpperCase() !== "DELETE") {
          alert('Type "DELETE" exactly to confirm permanent deletion.');
          return;
        }
      }
      return doDeleteTrade(t.tradeId);
    }
  };
}

function closeRemoveTradeModal() {
  document.getElementById("removeTradeOverlay").classList.remove("show");
}

function doArchiveTrade(tradeId) {
  const t = STATE.trades.find(x => x.tradeId === tradeId);
  if (!t) return;
  t.active = false;
  t.updatedAt = new Date().toISOString();
  STATE.lastUpdated = new Date();
  logActivity(`Trade archived: ${t.tradeName}`);
  firebaseSave();
  closeRemoveTradeModal();
  closeTradeModal();
  renderAll();
}

function doDeleteTrade(tradeId) {
  const t = STATE.trades.find(x => x.tradeId === tradeId);
  if (!t) return;
  (t.invoices || []).forEach(inv => {
    if (LOCAL_INVOICE_FILES[inv.invoiceId]) { URL.revokeObjectURL(LOCAL_INVOICE_FILES[inv.invoiceId]); delete LOCAL_INVOICE_FILES[inv.invoiceId]; }
  });
  STATE.trades = STATE.trades.filter(x => x.tradeId !== tradeId);
  STATE.lastUpdated = new Date();
  logActivity(`Trade permanently deleted: ${t.tradeName}`);
  firebaseSave();
  closeRemoveTradeModal();
  closeTradeModal();
  renderAll();
}

function restoreTrade(tradeId) {
  const t = STATE.trades.find(x => x.tradeId === tradeId);
  if (!t) return;
  t.active = true;
  t.updatedAt = new Date().toISOString();
  STATE.lastUpdated = new Date();
  logActivity(`Trade restored: ${t.tradeName}`);
  firebaseSave();
  renderAll();
  if (STATE.openTradeId === tradeId) renderTradeModal();
}

function escapeHtml(s) {
  if (s === null || s === undefined) return "";
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const escapeAttr = escapeHtml; // same escaping is safe inside "..." attribute values

/* ============================================================
   IMPORT / EXPORT
   ============================================================ */

function exportCSV() {
  const schedule = CACHED_SCHEDULE;
  const header = ["ID", "Milestone", "Start Date", "Duration (Business Days)", "Finish Date", "Status", "Progress %", "Trade", "Dependency", "Notes"];
  const rows = [header];
  STATE.milestones.forEach(m => {
    const sched = schedule[m.id];
    rows.push([
      m.id,
      m.name,
      sched ? isoDate(sched.start) : "",
      m.duration,
      sched ? isoDate(sched.finish) : "",
      m.status,
      m.progress,
      m.trade,
      m.dependency.join(";"),
      m.notes,
    ]);
  });
  const csv = rows.map(r => r.map(csvEscape).join(",")).join("\r\n");
  downloadFile(csv, `${PROJECT.id}-schedule.csv`, "text/csv");
  logActivity("Schedule exported to CSV.");
}

function exportTradeFinancialsCSV() {
  if (USER_ROLE !== "admin" && !PROJECT.showFinancialsToClients) {
    alert("Financial information isn't available for this project's client view.");
    return;
  }
  const header = ["Trade ID", "Trade Name", "Vendor", "Scope", "Milestone", "Contract Amount", "HST",
    "Approved Change Orders", "Revised Contract", "Total Invoiced", "Total Paid", "Outstanding",
    "Payment Status", "Trade Status", "PO Number", "Payment Terms", "Notes"];
  const rows = [header];
  STATE.trades.forEach(t => {
    rows.push([
      t.tradeId, t.tradeName, t.vendor, t.scope, milestoneNamesList(t.milestoneIds),
      t.contractAmount || 0, t.hst || 0,
      approvedChangeOrderTotal(t),
      revisedContractValue(t),
      tradeTotalInvoiced(t),
      tradeTotalPaid(t),
      tradeOutstanding(t),
      tradePaymentStatus(t),
      t.active ? "Active" : "Archived",
      t.poNumber || "",
      t.paymentTerms || "",
      t.notes || "",
    ]);
  });
  const csv = rows.map(r => r.map(csvEscape).join(",")).join("\r\n");
  downloadFile(csv, `${PROJECT.id}-trade-financials.csv`, "text/csv");
  logActivity("Trade financials exported to CSV.");
}

function csvEscape(val) {
  const s = String(val ?? "");
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function downloadFile(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        if (row.length > 1 || row[0] !== "") rows.push(row);
        row = [];
      } else field += c;
    }
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function importCSVFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const rows = parseCSV(reader.result);
      if (rows.length < 2) throw new Error("File appears to be empty.");
      const body = rows.slice(1).filter(r => r.length >= 10 && r[0] !== "");
      const seen = new Set();
      const newMilestones = body.map(r => {
        const id = parseInt(r[0], 10);
        const duration = parseInt(r[3], 10);
        const progress = parseInt(r[6], 10);
        const status = r[5].trim();
        if (isNaN(id)) throw new Error(`Invalid milestone ID: "${r[0]}"`);
        if (seen.has(id)) throw new Error(`Duplicate milestone ID: ${id}`);
        seen.add(id);
        if (isNaN(duration) || duration < 1) throw new Error(`Invalid duration for milestone #${id}`);
        if (isNaN(progress) || progress < 0 || progress > 100) throw new Error(`Invalid progress for milestone #${id}`);
        if (!STATUS_OPTIONS.includes(status)) throw new Error(`Invalid status "${status}" for milestone #${id}. Must be one of: ${STATUS_OPTIONS.join(", ")}`);
        const dependency = r[8].trim() ? r[8].split(";").map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n)) : [];
        // Preserve any existing financial data for this milestone ID — the
        // schedule CSV doesn't carry contract/invoice fields, so re-importing
        // a schedule must not wipe out financials already entered in the app.
        const existing = STATE.milestones.find(x => x.id === id);
        return {
          id, name: r[1].trim(), duration, dependency, manualStart: null,
          status, progress, trade: r[7].trim(), notes: r[9] ? r[9].trim() : "",
          contractPrice: existing ? existing.contractPrice : 0,
          changeOrders: existing ? existing.changeOrders : [],
          invoices: existing ? existing.invoices : [],
          paymentDetails: existing ? existing.paymentDetails : sanitizePaymentDetails({ vendorName: r[7].trim() }),
        };
      });
      // validate dependencies reference known ids
      const ids = new Set(newMilestones.map(m => m.id));
      newMilestones.forEach(m => m.dependency.forEach(d => {
        if (!ids.has(d)) throw new Error(`Milestone #${m.id} (${m.name}) references unknown dependency #${d}`);
      }));

      STATE.milestones = newMilestones;
      STATE.lastUpdated = new Date();
      STATE.statusFilter = "All";
      logActivity(`Schedule imported from CSV — ${newMilestones.length} milestones loaded.`);
      firebaseSave();
      renderAll();
      alert(`Import successful: ${newMilestones.length} milestones loaded.`);
    } catch (err) {
      alert("Import failed: " + err.message);
    }
  };
  reader.readAsText(file);
}

/* ============================================================
   RESET
   ============================================================ */

function resetSchedule() {
  if (USER_ROLE !== "admin") return;
  if (!confirm(`Reset the entire schedule AND all trades (contracts, change orders, invoices, payments) to the original ${PROJECT.address} baseline? This will discard everything entered this session and cannot be undone.`)) return;
  STATE.milestones = deepClone(BASELINE_MILESTONES);
  STATE.trades = deepClone(BASELINE_TRADES);
  STATE.holidays = deepClone(DEFAULT_HOLIDAYS);
  STATE.statusFilter = "All";
  STATE.tradeFilter = "active";
  STATE.activityPage = 1;
  Object.keys(LOCAL_INVOICE_FILES).forEach(k => { URL.revokeObjectURL(LOCAL_INVOICE_FILES[k]); delete LOCAL_INVOICE_FILES[k]; });
  STATE.lastUpdated = new Date();
  logActivity(`Schedule reset to original ${PROJECT.address} baseline.`);
  firebaseSave();
  renderAll();
}

/* ============================================================
   HOLIDAYS UI
   ============================================================ */

function addHoliday() {
  if (USER_ROLE !== "admin") return;
  const dateInput = document.getElementById("newHolidayDate");
  const nameInput = document.getElementById("newHolidayName");
  const date = dateInput.value;
  const name = nameInput.value.trim() || "Statutory Holiday";
  if (!date) { alert("Choose a date first."); return; }
  STATE.holidays.push({ date, name });
  dateInput.value = "";
  nameInput.value = "";
  STATE.lastUpdated = new Date();
  logActivity(`Holiday added: ${name} (${date})`);
  firebaseSave();
  renderAll();
}

function removeHoliday(index) {
  if (USER_ROLE !== "admin") return;
  const h = STATE.holidays[index];
  if (!h) return;
  if (!confirm(`Remove holiday "${h.name}" (${h.date})?`)) return;
  STATE.holidays.splice(index, 1);
  STATE.lastUpdated = new Date();
  logActivity(`Holiday removed: ${h.name} (${h.date})`);
  firebaseSave();
  renderAll();
}

/* ============================================================
   COMPANY LOGO
   ============================================================ */

function handleLogoFileUpload(file) {
  if (USER_ROLE !== "admin") return;
  const err = validateImageFile(file);
  if (err) { alert(err); return; }
  compressImageToDataUrl(file, 320, 0.85).then(dataUrl => {
    STATE.settings.companyLogoDataUrl = dataUrl;
    PROJECT.companyLogoDataUrl = dataUrl;
    return firebaseSaveSettings();
  }).then(() => {
    logActivity("Company logo updated.");
    renderAdminBrandingTab();
    renderHeader();
  }).catch(err => {
    console.error(err);
  });
}

function removeLogo() {
  if (USER_ROLE !== "admin") return;
  if (!confirm("Remove the company logo?")) return;
  STATE.settings.companyLogoDataUrl = null;
  PROJECT.companyLogoDataUrl = null;
  firebaseSaveSettings().then(() => {
    logActivity("Company logo removed.");
    renderAdminBrandingTab();
    renderHeader();
  }).catch(err => console.error(err));
}

/* ============================================================
   ADMIN PANEL
   ============================================================ */

let ADMIN_PANEL_TAB = "project";

function openAdminPanel() {
  if (USER_ROLE !== "admin") return;
  document.getElementById("adminPanelOverlay").classList.add("show");
  switchAdminTab("projects");
}
function closeAdminPanel() {
  document.getElementById("adminPanelOverlay").classList.remove("show");
}

function switchAdminTab(tab) {
  ADMIN_PANEL_TAB = tab;
  document.querySelectorAll("#adminPanelTabs .modal-tab").forEach(b => {
    b.classList.toggle("active", b.dataset.adminTab === tab);
  });
  if (tab === "projects") renderAdminProjectsTab();
  else if (tab === "project") renderAdminProjectTab();
  else if (tab === "branding") renderAdminBrandingTab();
  else if (tab === "milestones") renderAdminMilestonesList();
  else if (tab === "holidays") renderAdminHolidaysTab();
}

/* ============================================================
   ADMIN PANEL — Projects tab (multi-project management)
   ============================================================ */

function renderProjectSwitcher() {
  const el = document.getElementById("projectSwitcher");
  if (!el) return;
  const list = registryList(false);
  // Always include the currently-open project even if the registry
  // hasn't round-tripped yet (e.g. still bootstrapping on first admin
  // login) so the switcher never goes blank under the user.
  if (!list.some(p => p.id === CURRENT_PROJECT_ID)) {
    list.unshift({ id: CURRENT_PROJECT_ID, name: PROJECT.title || PROJECT.address || CURRENT_PROJECT_ID });
  }
  el.innerHTML = list.map(p => `<option value="${escapeAttr(p.id)}" ${p.id === CURRENT_PROJECT_ID ? "selected" : ""}>${escapeHtml(p.name || p.address || p.id)}</option>`).join("");
  el.style.display = list.length > 1 || USER_ROLE === "admin" ? "inline-block" : "none";
}

let ADMIN_PROJECT_FORM_MODE = null; // null | "create" | editingProjectId
let ADMIN_PROJECT_FORM_COVER = null; // staged cover image data URL

function renderAdminProjectsTab() {
  const el = document.getElementById("adminPanelBody");
  if (!el || ADMIN_PANEL_TAB !== "projects") return;

  if (ADMIN_PROJECT_FORM_MODE) {
    el.innerHTML = adminProjectFormHtml();
    wireAdminProjectForm();
    return;
  }

  const cards = registryList(true).map(p => {
    const isCurrent = p.id === CURRENT_PROJECT_ID;
    return `
      <div class="admin-project-card ${p.archived ? "archived" : ""}">
        <div class="admin-project-card-cover">${p.coverImageDataUrl ? `<img src="${p.coverImageDataUrl}" alt="">` : `<span>${escapeHtml((p.name || p.address || "?").slice(0, 1).toUpperCase())}</span>`}</div>
        <div style="flex:1; min-width:0;">
          <div class="amr-name">${escapeHtml(p.name || p.address || p.id)} ${isCurrent ? '<span class="status-pill st-approved">Current</span>' : ""} ${p.archived ? '<span class="status-pill st-gray">Archived</span>' : ""}</div>
          <div class="amr-meta">${escapeHtml(p.address || "")}${p.client ? " · " + escapeHtml(p.client) : ""}${p.status ? " · " + escapeHtml(p.status) : ""}</div>
        </div>
        <div class="admin-project-card-actions">
          ${!isCurrent ? `<button class="amr-btn" data-paction="open" data-id="${p.id}">Open</button>` : ""}
          <button class="amr-btn" data-paction="edit" data-id="${p.id}">Edit</button>
          <button class="amr-btn" data-paction="duplicate" data-id="${p.id}">Duplicate</button>
          ${p.archived
            ? `<button class="amr-btn" data-paction="restore" data-id="${p.id}">Restore</button>`
            : `<button class="amr-btn" data-paction="archive" data-id="${p.id}">Archive</button>`}
        </div>
      </div>
    `;
  }).join("");

  el.innerHTML = `
    <div class="admin-section-title">Projects (${registryList(false).length})</div>
    <div class="metric-note" style="margin-bottom:10px;">Every project's schedule, trades, financials, and activity are fully isolated in the database — nothing here is ever shared between projects.</div>
    <button class="btn primary" id="btnAdminCreateProject" style="margin-bottom:10px;">+ Create New Project</button>
    <div id="adminProjectCards">${cards || '<div class="empty-note">No other projects yet.</div>'}</div>
  `;

  document.getElementById("btnAdminCreateProject").onclick = () => {
    ADMIN_PROJECT_FORM_MODE = "create";
    ADMIN_PROJECT_FORM_COVER = null;
    renderAdminProjectsTab();
  };

  document.getElementById("adminProjectCards").onclick = (e) => {
    const btn = e.target.closest("[data-paction]");
    if (!btn) return;
    const id = btn.dataset.id;
    const action = btn.dataset.paction;
    if (action === "open") { switchProject(id); }
    else if (action === "edit") { ADMIN_PROJECT_FORM_MODE = id; ADMIN_PROJECT_FORM_COVER = null; renderAdminProjectsTab(); }
    else if (action === "archive") { archiveProject(id); }
    else if (action === "restore") { restoreProject(id); }
    else if (action === "duplicate") { openDuplicateProjectFlow(id); }
  };
}

function openDuplicateProjectFlow(sourceId) {
  if (sourceId !== CURRENT_PROJECT_ID) {
    alert(`To duplicate "${(PROJECT_REGISTRY[sourceId] || {}).name || sourceId}", switch to it first (Open), then Duplicate — this keeps the copy accurate to that project's actual current milestones and trades.`);
    return;
  }
  const src = PROJECT_REGISTRY[sourceId] || {};
  const newName = prompt(`Duplicate "${src.name || sourceId}" as (new project name):`, "");
  if (!newName || !newName.trim()) return;
  const newAddress = prompt("New project address:", "") || newName.trim();
  createProject({
    name: newName.trim(),
    address: newAddress.trim(),
    projectType: src.projectType || "",
    status: "Not Started",
    startDate: isoDate(new Date()),
    targetCompletion: src.targetCompletion || isoDate(new Date()),
    copyFrom: sourceId,
  }).then(() => {
    alert(`"${newName.trim()}" created with ${src.name || sourceId}'s milestone and trade structure. Invoices, payments, and actuals were NOT copied.`);
  });
}

function adminProjectFormHtml() {
  const editing = ADMIN_PROJECT_FORM_MODE !== "create";
  const entry = editing ? (PROJECT_REGISTRY[ADMIN_PROJECT_FORM_MODE] || {}) : {};
  const cover = ADMIN_PROJECT_FORM_COVER || entry.coverImageDataUrl || null;
  return `
    <div class="admin-section-title">${editing ? "Edit Project" : "Create New Project"}</div>
    <div class="field"><label>Project Name</label><input id="pfName" value="${escapeAttr(entry.name || "")}"></div>
    <div class="field"><label>Project Address</label><input id="pfAddress" value="${escapeAttr(entry.address || "")}"></div>
    <div class="field-row">
      <div class="field"><label>Project Number</label><input id="pfNumber" value="${escapeAttr(entry.projectNumber || "")}"></div>
      <div class="field"><label>Client</label><input id="pfClient" value="${escapeAttr(entry.client || "")}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Project Type</label><input id="pfType" value="${escapeAttr(entry.projectType || "")}" placeholder="e.g. Residential Construction"></div>
      <div class="field"><label>Project Status</label>
        <select id="pfStatus">${["Not Started","In Progress","On Hold","Complete"].map(o => `<option ${entry.status===o?"selected":""}>${o}</option>`).join("")}</select>
      </div>
    </div>
    <div class="field-row">
      <div class="field"><label>Project Start Date</label><input type="date" id="pfStart" value="${entry.startDate || ""}"></div>
      <div class="field"><label>Target Completion Date</label><input type="date" id="pfTarget" value="${entry.targetCompletion || ""}"></div>
    </div>
    <div class="field"><label>Project Manager</label><input id="pfManager" value="${escapeAttr(entry.projectManager || "")}"></div>
    <div class="field"><label>Project Description</label><textarea id="pfDescription">${escapeHtml(entry.description || "")}</textarea></div>
    <div class="field">
      <label>Project Image / Cover Image</label>
      <div class="logo-preview-row">
        <div class="logo-preview-box">${cover ? `<img src="${cover}" alt="">` : "No image"}</div>
        <button class="btn" id="pfBtnUploadCover" type="button">Upload Image</button>
        <input type="file" id="pfCoverInput" accept="image/png,image/jpeg,image/webp" style="display:none">
      </div>
    </div>
    <div class="field"><label>Notes</label><textarea id="pfNotes">${escapeHtml(entry.notes || "")}</textarea></div>
    <div class="modal-error" id="pfError"></div>
    <div style="display:flex; gap:8px;">
      <button class="btn" id="pfBtnCancel" type="button">Cancel</button>
      <button class="btn primary" id="pfBtnSave" type="button">${editing ? "Save Changes" : "Create Project"}</button>
    </div>
  `;
}

function wireAdminProjectForm() {
  document.getElementById("pfBtnCancel").onclick = () => { ADMIN_PROJECT_FORM_MODE = null; renderAdminProjectsTab(); };
  document.getElementById("pfBtnUploadCover").onclick = () => document.getElementById("pfCoverInput").click();
  document.getElementById("pfCoverInput").onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!validateImageFile(file)) return;
    compressImageToDataUrl(file, 800, 0.75).then((dataUrl) => {
      ADMIN_PROJECT_FORM_COVER = dataUrl;
      renderAdminProjectsTab();
    });
  };
  document.getElementById("pfBtnSave").onclick = () => {
    const errEl = document.getElementById("pfError");
    const form = {
      name: document.getElementById("pfName").value.trim(),
      address: document.getElementById("pfAddress").value.trim(),
      projectNumber: document.getElementById("pfNumber").value.trim(),
      client: document.getElementById("pfClient").value.trim(),
      projectType: document.getElementById("pfType").value.trim(),
      status: document.getElementById("pfStatus").value,
      startDate: document.getElementById("pfStart").value,
      targetCompletion: document.getElementById("pfTarget").value,
      projectManager: document.getElementById("pfManager").value.trim(),
      description: document.getElementById("pfDescription").value.trim(),
      notes: document.getElementById("pfNotes").value.trim(),
      coverImageDataUrl: ADMIN_PROJECT_FORM_COVER !== null ? ADMIN_PROJECT_FORM_COVER : undefined,
    };
    if (!form.name && !form.address) { errEl.textContent = "Project Name or Address is required."; return; }

    if (ADMIN_PROJECT_FORM_MODE === "create") {
      createProject(form).then(() => {
        ADMIN_PROJECT_FORM_MODE = null;
        closeAdminPanel();
      });
    } else {
      const id = ADMIN_PROJECT_FORM_MODE;
      const patch = Object.assign({}, form);
      if (patch.coverImageDataUrl === undefined) delete patch.coverImageDataUrl;
      updateProjectRegistryEntry(id, patch).then(() => {
        // Keep the live settings of the project actually loaded right now
        // in sync too, so editing "the current project" from here behaves
        // exactly like editing it from the Project tab.
        if (id === CURRENT_PROJECT_ID) {
          Object.assign(STATE.settings, {
            title: form.name || STATE.settings.title,
            address: form.address || STATE.settings.address,
            clientName: form.client,
            projectType: form.projectType,
            status: form.status,
            start: form.startDate || STATE.settings.start,
            targetCompletion: form.targetCompletion || STATE.settings.targetCompletion,
            projectManager: form.projectManager,
            description: form.description,
          });
          PROJECT = Object.assign({}, STATE.settings, { id: CURRENT_PROJECT_ID });
          firebaseSaveSettings();
          renderAll();
        }
        logActivity(`Project updated: "${form.name || form.address}".`);
        ADMIN_PROJECT_FORM_MODE = null;
        renderAdminProjectsTab();
      });
    }
  };
}

function renderAdminProjectTab() {
  const s = STATE.settings;
  const el = document.getElementById("adminPanelBody");
  el.innerHTML = `
    <div class="admin-section-title">Project Information</div>
    <div class="field"><label>Project Title</label><input id="apTitle" value="${escapeAttr(s.title)}"></div>
    <div class="field"><label>Address</label><input id="apAddress" value="${escapeAttr(s.address)}"></div>
    <div class="field"><label>Client Name</label><input id="apClientName" value="${escapeAttr(s.clientName)}"></div>
    <div class="field-row">
      <div class="field"><label>Project Type</label><input id="apProjectType" value="${escapeAttr(s.projectType)}"></div>
      <div class="field"><label>Status</label>
        <select id="apStatus">
          ${["Not Started","In Progress","On Hold","Complete"].map(o => `<option ${s.status===o?"selected":""}>${o}</option>`).join("")}
        </select>
      </div>
    </div>
    <div class="field-row">
      <div class="field"><label>Start Date</label><input type="date" id="apStart" value="${s.start}"></div>
      <div class="field"><label>Target Completion</label><input type="date" id="apTarget" value="${s.targetCompletion}"></div>
    </div>
    <div class="field"><label>Description</label><textarea id="apDescription">${escapeHtml(s.description)}</textarea></div>
    <div class="field-row">
      <div class="field"><label>Construction Manager</label><input id="apManager" value="${escapeAttr(s.projectManager)}"></div>
      <div class="field"><label>Project Operations Coordinator</label><input id="apOpsCoordinator" value="${escapeAttr(s.operationsCoordinator)}"></div>
    </div>
    <div class="field"><label>Client Contact</label><input id="apContact" value="${escapeAttr(s.contact)}"></div>
    <div class="field"><label>Subtitle</label><input id="apSubtitle" value="${escapeAttr(s.subtitle)}"></div>
    <div class="field"><label>Footer Text (optional — blank uses default)</label><input id="apFooterText" value="${escapeAttr(s.footerText)}"></div>
    <div class="field" style="flex-direction:row; align-items:center; gap:8px;">
      <input type="checkbox" id="apShowFinancials" ${s.showFinancialsToClients ? "checked" : ""} style="width:auto;">
      <label style="margin:0; text-transform:none; font-size:13px; font-weight:600; color:var(--text);">Show financial information to clients (contract values, invoices, payments)</label>
    </div>
    <div class="modal-error" id="apError"></div>
    <button class="btn primary" id="btnSaveProjectSettings">Save Project Settings</button>
  `;
  document.getElementById("btnSaveProjectSettings").onclick = saveProjectSettingsFromForm;
}

function saveProjectSettingsFromForm() {
  const errEl = document.getElementById("apError");
  const start = document.getElementById("apStart").value;
  const target = document.getElementById("apTarget").value;
  const title = document.getElementById("apTitle").value.trim();
  const address = document.getElementById("apAddress").value.trim();
  if (!address) { errEl.textContent = "Address is required."; return; }
  if (!start || !target) { errEl.textContent = "Start date and target completion are required."; return; }
  if (parseISO(target) < parseISO(start)) { errEl.textContent = "Target completion can't be before the start date."; return; }

  const changes = [];
  const s = STATE.settings;
  if (s.title !== title) changes.push("title");
  if (s.address !== address) changes.push("address");
  if (s.start !== start) changes.push("start date");
  if (s.targetCompletion !== target) changes.push("target completion");

  s.title = title;
  s.address = address;
  s.clientName = document.getElementById("apClientName").value.trim();
  s.projectType = document.getElementById("apProjectType").value.trim();
  s.status = document.getElementById("apStatus").value;
  s.start = start;
  s.targetCompletion = target;
  s.description = document.getElementById("apDescription").value.trim();
  s.projectManager = document.getElementById("apManager").value.trim();
  s.operationsCoordinator = document.getElementById("apOpsCoordinator").value.trim();
  s.contact = document.getElementById("apContact").value.trim();
  s.subtitle = document.getElementById("apSubtitle").value.trim();
  s.footerText = document.getElementById("apFooterText").value.trim();
  s.showFinancialsToClients = document.getElementById("apShowFinancials").checked;

  PROJECT = Object.assign({}, s, { id: CURRENT_PROJECT_ID });
  errEl.textContent = "";
  firebaseSaveSettings().then(() => {
    logActivity(changes.length ? `Project settings updated: ${changes.join(", ")}.` : "Project settings updated.");
    renderAll();
  }).catch(() => {
    errEl.textContent = "Couldn't save — check you're still logged in.";
  });
}

function renderAdminBrandingTab() {
  const s = STATE.settings;
  const el = document.getElementById("adminPanelBody");
  el.innerHTML = `
    <div class="admin-section-title">Company Logo</div>
    <div class="logo-preview-row">
      <div class="logo-preview-box">
        ${s.companyLogoDataUrl ? `<img src="${s.companyLogoDataUrl}" alt="Logo preview">` : "No logo"}
      </div>
      <div style="display:flex; flex-direction:column; gap:6px;">
        <button class="btn primary" id="btnUploadLogo">${s.companyLogoDataUrl ? "Replace Logo" : "Upload Logo"}</button>
        ${s.companyLogoDataUrl ? `<button class="btn danger" id="btnRemoveLogo">Remove Logo</button>` : ""}
      </div>
    </div>
    <div class="metric-note">JPG, PNG, or WEBP. Automatically resized and compressed for fast loading.</div>
    <div class="admin-section-title" style="margin-top:16px;">Company Name</div>
    <div class="field"><input id="apCompanyName" value="${escapeAttr(s.companyName)}"></div>
    <button class="btn primary" id="btnSaveCompanyName">Save</button>
  `;
  document.getElementById("btnUploadLogo").onclick = () => document.getElementById("logoFileInput").click();
  const rmBtn = document.getElementById("btnRemoveLogo");
  if (rmBtn) rmBtn.onclick = removeLogo;
  document.getElementById("btnSaveCompanyName").onclick = () => {
    STATE.settings.companyName = document.getElementById("apCompanyName").value.trim();
    firebaseSaveSettings().then(() => {
      logActivity("Company name updated.");
      PROJECT.companyName = STATE.settings.companyName;
    });
  };
}

function renderAdminHolidaysTab() {
  const el = document.getElementById("adminPanelBody");
  el.innerHTML = `
    <div class="admin-section-title">Statutory Holidays</div>
    <div id="apHolidayList"></div>
    <div class="holiday-add" style="margin-top:10px;">
      <input type="date" id="apNewHolidayDate">
      <input type="text" id="apNewHolidayName" placeholder="Holiday name">
      <button class="btn primary" id="apBtnAddHoliday">Add Holiday</button>
    </div>
  `;
  const listEl = document.getElementById("apHolidayList");
  STATE.holidays.slice().sort((a, b) => a.date.localeCompare(b.date)).forEach((h) => {
    const realIndex = STATE.holidays.indexOf(h);
    const row = document.createElement("div");
    row.className = "holiday-row";
    row.innerHTML = `<span>${fmtDate(parseISO(h.date))} — ${escapeHtml(h.name)}</span>`;
    const rm = document.createElement("button");
    rm.className = "icon-btn";
    rm.textContent = "×";
    rm.onclick = () => { removeHoliday(realIndex); renderAdminHolidaysTab(); };
    row.appendChild(rm);
    listEl.appendChild(row);
  });
  document.getElementById("apBtnAddHoliday").onclick = () => {
    addHoliday(); // uses the same #newHolidayDate ids? no -- see below
  };
  // addHoliday() reads from the header panel's input ids; wire this form's
  // own inputs directly instead so the admin panel doesn't depend on the
  // (possibly hidden) header holiday panel being open.
  document.getElementById("apBtnAddHoliday").onclick = () => {
    if (USER_ROLE !== "admin") return;
    const date = document.getElementById("apNewHolidayDate").value;
    const name = document.getElementById("apNewHolidayName").value.trim() || "Statutory Holiday";
    if (!date) { alert("Choose a date first."); return; }
    STATE.holidays.push({ date, name });
    STATE.lastUpdated = new Date();
    logActivity(`Holiday added: ${name} (${date})`);
    firebaseSave();
    renderAll();
    renderAdminHolidaysTab();
  };
}

/* ============================================================
   MILESTONE MANAGEMENT — add / duplicate / delete / reorder
   ============================================================ */

// Keeps the explicit `order` field on every milestone in sync with its
// current array position (1-based). Array position is, and remains, the
// single source of truth for display order everywhere (Gantt, mobile
// list, upcoming milestones, CSV export) -- `order` is a persisted,
// explicit mirror of that so the sequence is never inferred from
// something as fragile as "whatever order Firebase happens to return
// array items in," and so a future normalized data model has a real
// field to key off. This never touches dependency, date, or duration
// data -- order and scheduling are intentionally independent.
function renumberMilestoneOrder() {
  STATE.milestones.forEach((m, i) => { m.order = i + 1; });
}

// One-time backward-compat migration for milestones saved before the
// `order` field existed (sentinel value 0 from rehydrateMilestone).
// Assigns order strictly from each milestone's CURRENT array position --
// i.e. whatever sequence was already live is preserved exactly, nothing
// is reshuffled.
function migrateMilestoneOrder() {
  const needsMigration = STATE.milestones.some(m => !m.order || m.order === 0);
  if (needsMigration) renumberMilestoneOrder();
  return needsMigration;
}

function nextMilestoneId() {
  return STATE.milestones.length ? Math.max(...STATE.milestones.map(m => m.id)) + 1 : 1;
}

function addMilestone() {
  if (USER_ROLE !== "admin") return;
  const name = prompt("New milestone name:");
  if (!name || !name.trim()) return;
  const newMilestone = {
    id: nextMilestoneId(),
    name: name.trim(),
    description: "",
    order: STATE.milestones.length + 1,
    duration: 5,
    dependency: [],
    manualStart: null,
    status: "Not Started",
    progress: 0,
    trade: "",
    priority: "Normal",
    notes: "",
    contractPrice: 0,
    changeOrders: [],
    invoices: [],
    gallery: [],
    paymentDetails: { vendorName: "", poNumber: "", paymentTerms: "", paymentMethod: "", bankName: "", accountName: "", accountLast4: "", paymentReference: "", notes: "" },
  };
  STATE.milestones.push(newMilestone);
  renumberMilestoneOrder();
  STATE.lastUpdated = new Date();
  logActivity(`Milestone added: "${newMilestone.name}".`);
  firebaseSave();
  renderAll();
  renderAdminMilestonesList();
}

function duplicateMilestone(id) {
  if (USER_ROLE !== "admin") return;
  const m = STATE.milestones.find(x => x.id === id);
  if (!m) return;
  const copy = deepClone(m);
  copy.id = nextMilestoneId();
  copy.name = m.name + " (Copy)";
  copy.dependency = []; // avoid ambiguous duplicate dependency chains — admin can reassign
  copy.manualStart = null;
  copy.gallery = []; // photos are milestone-specific; don't duplicate them onto a new phase
  STATE.milestones.push(copy);
  renumberMilestoneOrder();
  STATE.lastUpdated = new Date();
  logActivity(`Milestone duplicated: "${m.name}" → "${copy.name}".`);
  firebaseSave();
  closeModal();
  renderAll();
  renderAdminMilestonesList();
}

function deleteMilestoneById(id) {
  if (USER_ROLE !== "admin") return;
  const m = STATE.milestones.find(x => x.id === id);
  if (!m) return;
  const dependents = STATE.milestones.filter(x => (x.dependency || []).includes(id));
  let msg = `Delete milestone "${m.name}"? This can't be undone.`;
  if (dependents.length) {
    msg = `"${m.name}" is a dependency for: ${dependents.map(d => d.name).join(", ")}.\n\nDeleting it will remove it from their dependencies too (their schedule may shift). Continue?`;
  }
  if (!confirm(msg)) return;
  STATE.milestones = STATE.milestones.filter(x => x.id !== id);
  STATE.milestones.forEach(x => { x.dependency = (x.dependency || []).filter(d => d !== id); });
  renumberMilestoneOrder();
  STATE.lastUpdated = new Date();
  logActivity(`Milestone deleted: "${m.name}".`);
  firebaseSave();
  closeModal();
  renderAll();
  renderAdminMilestonesList();
}

// Moves a milestone up (direction -1) or down (direction +1) by one
// position. This ONLY changes array position / the `order` field -- it
// never touches dependency, manualStart, duration, or any date. Sequence
// and scheduling remain fully independent, per spec.
function reorderMilestone(id, direction) {
  if (USER_ROLE !== "admin") return;
  const idx = STATE.milestones.findIndex(x => x.id === id);
  if (idx === -1) return;
  const swapWith = idx + direction;
  if (swapWith < 0 || swapWith >= STATE.milestones.length) return;
  const m = STATE.milestones[idx];
  const oldPos = idx + 1;
  const newPos = swapWith + 1;
  const tmp = STATE.milestones[idx];
  STATE.milestones[idx] = STATE.milestones[swapWith];
  STATE.milestones[swapWith] = tmp;
  renumberMilestoneOrder();
  STATE.lastUpdated = new Date();
  logActivity(`Milestone order changed: "${m.name}" moved from #${oldPos} to #${newPos}.`);
  firebaseSave();
  renderAll();
  renderAdminMilestonesList();
}

// Drag-and-drop reorder: moves the milestone at `fromIndex` to sit at
// `toIndex`, shifting everything between. Same guarantees as
// reorderMilestone() above -- only order changes, nothing schedule-related.
function moveMilestoneToIndex(fromIndex, toIndex) {
  if (USER_ROLE !== "admin") return;
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return;
  if (fromIndex >= STATE.milestones.length || toIndex >= STATE.milestones.length) return;
  const m = STATE.milestones[fromIndex];
  const oldPos = fromIndex + 1;
  const newPos = toIndex + 1;
  STATE.milestones.splice(fromIndex, 1);
  STATE.milestones.splice(toIndex, 0, m);
  renumberMilestoneOrder();
  STATE.lastUpdated = new Date();
  logActivity(`Milestone order changed: "${m.name}" moved from #${oldPos} to #${newPos}.`);
  firebaseSave();
  renderAll();
  renderAdminMilestonesList();
}

/* ============================================================
   ADMIN PANEL — Milestones tab
   Dedicated reorder UI: ▲/▼ buttons (required, always available,
   the accessible/mobile-friendly mechanism) plus optional drag-and-
   drop via a ☰ handle. Buttons work with or without drag-and-drop.
   ============================================================ */

let DRAG_FROM_INDEX = null;

function renderAdminMilestonesList() {
  const el = document.getElementById("adminPanelBody");
  if (!el || ADMIN_PANEL_TAB !== "milestones") return;

  const rows = STATE.milestones.map((m, i) => {
    const isFirst = i === 0;
    const isLast = i === STATE.milestones.length - 1;
    return `
      <div class="admin-milestone-row" draggable="true" data-idx="${i}" data-id="${m.id}">
        <span class="amr-drag-handle" title="Drag to reorder">☰</span>
        <span class="amr-num">${i + 1}.</span>
        <div style="flex:1; min-width:0;">
          <div class="amr-name">${escapeHtml(m.name)}</div>
          <div class="amr-meta">${escapeHtml(m.status)} · ${m.progress}% · ${escapeHtml(m.trade || "No trade assigned")}</div>
        </div>
        <button class="amr-btn" data-maction="edit" data-id="${m.id}">Edit</button>
        <button class="amr-btn" data-maction="up" data-id="${m.id}" ${isFirst ? "disabled" : ""} title="Move up" aria-label="Move ${escapeAttr(m.name)} up">▲</button>
        <button class="amr-btn" data-maction="down" data-id="${m.id}" ${isLast ? "disabled" : ""} title="Move down" aria-label="Move ${escapeAttr(m.name)} down">▼</button>
      </div>
    `;
  }).join("");

  el.innerHTML = `
    <div class="admin-section-title">Milestones (${STATE.milestones.length})</div>
    <div class="metric-note" style="margin-bottom:10px;">Drag the ☰ handle, or use ▲/▼ — both save instantly and update the Gantt, mobile list, and upcoming milestones. Reordering never changes dates or dependencies.</div>
    <button class="btn primary" id="btnAdminAddMilestone" style="margin-bottom:10px;">+ Add Milestone</button>
    <div id="adminMilestoneRows">${rows}</div>
  `;

  document.getElementById("btnAdminAddMilestone").onclick = addMilestone;

  const rowsEl = document.getElementById("adminMilestoneRows");
  rowsEl.onclick = (e) => {
    const btn = e.target.closest("[data-maction]");
    if (!btn || btn.disabled) return;
    const id = parseInt(btn.dataset.id, 10);
    if (btn.dataset.maction === "edit") { closeAdminPanel(); openModal(id); }
    if (btn.dataset.maction === "up") reorderMilestone(id, -1);
    if (btn.dataset.maction === "down") reorderMilestone(id, 1);
  };

  // Native HTML5 drag-and-drop -- required buttons above remain the
  // primary, always-available mechanism (esp. on mobile, where drag
  // targets are unreliable); this is a nice-to-have on top.
  rowsEl.querySelectorAll(".admin-milestone-row").forEach(row => {
    row.addEventListener("dragstart", (e) => {
      DRAG_FROM_INDEX = parseInt(row.dataset.idx, 10);
      e.dataTransfer.effectAllowed = "move";
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", () => row.classList.remove("dragging"));
    row.addEventListener("dragover", (e) => { e.preventDefault(); row.classList.add("drag-over"); });
    row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      row.classList.remove("drag-over");
      const toIndex = parseInt(row.dataset.idx, 10);
      if (DRAG_FROM_INDEX !== null) moveMilestoneToIndex(DRAG_FROM_INDEX, toIndex);
      DRAG_FROM_INDEX = null;
    });
  });
}

/* ============================================================
   INIT
   ============================================================ */

function init() {
  document.getElementById("btnExport").onclick = exportCSV;
  document.getElementById("btnExportFinancials").onclick = exportTradeFinancialsCSV;
  document.getElementById("btnImport").onclick = () => document.getElementById("csvFileInput").click();
  document.getElementById("csvFileInput").onchange = (e) => {
    if (e.target.files[0]) importCSVFile(e.target.files[0]);
    e.target.value = "";
  };
  document.getElementById("btnReset").onclick = resetSchedule;
  document.getElementById("btnAddHoliday").onclick = addHoliday;
  document.getElementById("btnCloseModal").onclick = closeModal;
  document.getElementById("btnCancelModal").onclick = closeModal;
  document.getElementById("btnSaveModal").onclick = saveModal;
  document.getElementById("btnClearManualStart").onclick = clearManualStart;
  document.getElementById("btnDuplicateModal").onclick = () => duplicateMilestone(STATE.openMilestoneId);
  document.getElementById("btnDeleteModal").onclick = () => deleteMilestoneById(STATE.openMilestoneId);
  document.getElementById("btnMoveUpModal").onclick = () => reorderMilestone(STATE.openMilestoneId, -1);
  document.getElementById("btnMoveDownModal").onclick = () => reorderMilestone(STATE.openMilestoneId, 1);
  document.getElementById("mProgress").oninput = (e) => {
    document.getElementById("mProgressLabel").textContent = e.target.value + "%";
  };
  document.getElementById("modalOverlay").onclick = (e) => {
    if (e.target.id === "modalOverlay") closeModal();
  };
  document.getElementById("btnToggleHolidays").onclick = () => {
    document.getElementById("holidayPanel").classList.toggle("show");
  };
  document.getElementById("tabBtnSchedule").onclick = () => switchModalTab("schedule");
  document.getElementById("tabBtnFinancials").onclick = () => switchModalTab("financials");
  document.getElementById("tabBtnGallery").onclick = () => switchModalTab("gallery");

  document.getElementById("btnAddTrade").onclick = () => openTradeModal(null);
  document.getElementById("btnAddMilestone").onclick = addMilestone;
  document.getElementById("tradeCostTableBody").onclick = handleTradeTableClick;
  document.getElementById("siteRentalsTableBody").onclick = handleTradeTableClick;
  document.getElementById("btnCloseTradeModal").onclick = closeTradeModal;
  document.getElementById("btnCancelTradeModal").onclick = closeTradeModal;
  document.getElementById("tradeModalOverlay").onclick = (e) => {
    if (e.target.id === "tradeModalOverlay") closeTradeModal();
  };
  document.getElementById("removeTradeOverlay").onclick = (e) => {
    if (e.target.id === "removeTradeOverlay") closeRemoveTradeModal();
  };

  // ---------- Budget vs Actual ----------
  document.getElementById("btnAddBudgetCategory").onclick = () => openBudgetModal(null);
  document.getElementById("btnCloseBudgetModal").onclick = closeBudgetModal;
  document.getElementById("btnCancelBudgetModal").onclick = closeBudgetModal;
  document.getElementById("budgetModalOverlay").onclick = (e) => {
    if (e.target.id === "budgetModalOverlay") closeBudgetModal();
  };
  document.getElementById("budgetBasisSelect").onchange = (e) => {
    if (USER_ROLE !== "admin") return;
    STATE.settings.actualExpenseBasis = e.target.value;
    firebaseSaveSettings().then(() => {
      logActivity(`Actual Expense Basis changed to: ${e.target.value === "Paid" ? "Paid Amount" : e.target.value === "Manual" ? "Manually Entered" : "Invoice Amount"}.`);
      renderAll();
    });
  };

  document.getElementById("btnActivityPrev").onclick = () => { STATE.activityPage--; renderActivity(); };
  document.getElementById("btnActivityNext").onclick = () => { STATE.activityPage++; renderActivity(); };

  // ---------- Auth / role ----------
  document.getElementById("btnLogin").onclick = openLoginModal;
  document.getElementById("btnCloseLoginModal").onclick = closeLoginModal;
  document.getElementById("btnCancelLogin").onclick = closeLoginModal;
  document.getElementById("btnSubmitLogin").onclick = handleLogin;
  document.getElementById("loginPassword").addEventListener("keydown", (e) => { if (e.key === "Enter") handleLogin(); });
  document.getElementById("loginModalOverlay").onclick = (e) => {
    if (e.target.id === "loginModalOverlay") closeLoginModal();
  };
  document.getElementById("btnLogout").onclick = handleLogout;

  // ---------- Admin panel ----------
  document.getElementById("btnOpenAdminPanel").onclick = openAdminPanel;
  document.getElementById("btnCloseAdminPanel").onclick = closeAdminPanel;
  document.getElementById("btnCloseAdminPanel2").onclick = closeAdminPanel;
  document.getElementById("adminPanelOverlay").onclick = (e) => {
    if (e.target.id === "adminPanelOverlay") closeAdminPanel();
  };
  document.getElementById("adminPanelTabs").onclick = (e) => {
    const btn = e.target.closest("[data-admin-tab]");
    if (btn) switchAdminTab(btn.dataset.adminTab);
  };

  // ---------- Project switcher ----------
  const switcherEl = document.getElementById("projectSwitcher");
  if (switcherEl) switcherEl.onchange = (e) => switchProject(e.target.value);

  // ---------- Logo / gallery uploads ----------
  document.getElementById("logoFileInput").onchange = (e) => {
    if (e.target.files[0]) handleLogoFileUpload(e.target.files[0]);
    e.target.value = "";
  };
  document.getElementById("galleryFileInput").onchange = (e) => {
    if (e.target.files.length) handleGalleryFileUpload(e.target.files);
    e.target.value = "";
  };

  // ---------- Lightbox ----------
  document.getElementById("btnCloseLightbox").onclick = closeLightbox;
  document.getElementById("btnLightboxPrev").onclick = () => lightboxNav(-1);
  document.getElementById("btnLightboxNext").onclick = () => lightboxNav(1);
  document.getElementById("lightboxOverlay").onclick = (e) => {
    if (e.target.id === "lightboxOverlay") closeLightbox();
  };
  document.addEventListener("keydown", (e) => {
    if (!document.getElementById("lightboxOverlay").classList.contains("show")) return;
    if (e.key === "Escape") closeLightbox();
    if (e.key === "ArrowLeft") lightboxNav(-1);
    if (e.key === "ArrowRight") lightboxNav(1);
  });

  renderTradeFilterTabs();
  initAuth();
  firebaseListen();
  listenProjectRegistry();
}

document.addEventListener("DOMContentLoaded", init);
