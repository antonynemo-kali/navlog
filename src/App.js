import React, { useMemo, useRef } from "react";

/**
 * NavlogTracker (UI adapted from your provided component)
 *
 * Inline reducer version:
 * ✅ Replaces useState with useReducer (state.waypoints / state.computed / state.actualTO / state.fpl)
 * ✅ Uses your existing UI layout and modal flow
 * ✅ Keeps your exact 2-line header + X-aware parser
 * ✅ Planned ETA = ICAO Item 13 (dep time) + T/TME
 * ✅ Planned fuel = FRMG (tenths)
 * ✅ Planned burn = TBO (tenths)
 * ✅ Updated fuel = Actual TO fuel - TBO (tenths) OR propagated from last actual anchor
 * ✅ Guardrails for negative / increasing fuel + FIR T/TME vs EET/
 */

// ---------------------- Lazy-load pdf.js (legacy) ----------------------
async function loadPdfjs() {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf");
  try {
    const v = pdfjsLib.version || "3.11.174";
    pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${v}/pdf.worker.min.js`;
  } catch {}
  return pdfjsLib;
}

// ---------------------- Helpers (UI) ----------------------
const headerStyle = {
  padding: "12px",
  textAlign: "left",
  borderBottom: "2px solid #ddd",
};
const cellStyle = { padding: "10px 12px", textAlign: "left" };
const mono = {
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
};

function normalizeSpaces(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim();
}
function rowText(row) {
  return normalizeSpaces(row.cells.map((c) => c.text).join(" "));
}
function isPlaceholder(x) {
  return (
    x === "..." ||
    x === "...." ||
    x === "---" ||
    x === "----" ||
    x === "------" ||
    x === "--/---"
  );
}
function extractCoordFromText(t) {
  const m = String(t).match(
    /([NS]\d{1,2}\s+\d{1,2}(?:\.\d+)?\s+[EW]\d{2,3}\s+\d{1,2}(?:\.\d+)?)/
  );
  return m ? m[1].trim() : "";
}
function isPureCoordRow(t) {
  return /^[NS]\d{1,2}\s+\d{1,2}(?:\.\d+)?\s+[EW]\d{2,3}\s+\d{1,2}(?:\.\d+)?$/.test(
    String(t).trim()
  );
}
function isFormattingOnlyRow(t) {
  const u = String(t).toUpperCase().trim();
  return /^-?\s*_?\s*FL\s*[-–]\s*\d{2,3}\s*$/.test(u);
}
function extractFirIdent(t) {
  const m = String(t)
    .toUpperCase()
    .match(/FIR\s*-?>\s*([A-Z0-9]{3,6})\s*(?:<-)?/);
  return m ? `-${m[1]}` : "";
}

// Time helpers (support HHMM, HH.MM, HH:MM)
function timeToMinutesFlexible(timeStr) {
  if (!timeStr) return null;
  const s = String(timeStr).trim();

  // HHMM
  if (/^\d{3,4}$/.test(s)) {
    const p = s.padStart(4, "0");
    const hh = Number(p.slice(0, 2));
    const mm = Number(p.slice(2, 4));
    if (hh > 23 || mm > 59) return null;
    return hh * 60 + mm;
  }

  // HH.MM or HH:MM
  const cleaned = s.replace(":", ".");
  const m = cleaned.match(/^(\d{1,2})\.(\d{1,2})$/);
  if (m) {
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (hh > 23 || mm > 59) return null;
    return hh * 60 + mm;
  }

  return null;
}
function minutesToHHMM(min) {
  if (min == null || !Number.isFinite(min)) return "";
  let m = Math.round(min);
  m = ((m % (24 * 60)) + 24 * 60) % (24 * 60);
  const hh = String(Math.floor(m / 60)).padStart(2, "0");
  const mm = String(m % 60).padStart(2, "0");
  return `${hh}${mm}`;
}
function hhmmToDisplayHHdotMM(hhmm) {
  if (!hhmm || !/^\d{3,4}$/.test(hhmm)) return "";
  const p = hhmm.padStart(4, "0");
  return `${p.slice(0, 2)}.${p.slice(2, 4)}`;
}
function tTmeToMinutes(tTme) {
  const s = String(tTme || "").trim();
  const m = s.match(/^(\d{1,2})\.(\d{2})$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (mm > 59) return null;
  return hh * 60 + mm;
}

// Fuel helpers (tenths)
function digitsToTenths(raw) {
  const s = String(raw || "").replace(/\D/g, "");
  if (!s) return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}
function uiFuelToTenths(uiStr) {
  const n = Number(String(uiStr || "").trim());
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10);
}
function tenthsToUi(tenths) {
  const n = Number(tenths || 0);
  return (n / 10).toFixed(1);
}
function eetHHMMToTtmeDisplay(eetHHMM) {
  if (!eetHHMM || !/^\d{4}$/.test(eetHHMM)) return "";
  return `${eetHHMM.slice(0, 2)}.${eetHHMM.slice(2, 4)}`;
}
function computePlannedETA(actualTO_HHMM, t_tme) {
  if (!actualTO_HHMM || !t_tme) return "";

  // Parse actual TO time
  const toStr = String(actualTO_HHMM).padStart(4, "0");
  const toHH = parseInt(toStr.slice(0, 2), 10);
  const toMM = parseInt(toStr.slice(2, 4), 10);

  // Parse T_TME (format "HH.MM")
  const parts = String(t_tme).split(".");
  const addHH = parseInt(parts[0] || "0", 10);
  const addMM = parseInt(parts[1] || "0", 10);

  if (isNaN(toHH) || isNaN(toMM) || isNaN(addHH) || isNaN(addMM)) {
    return "";
  }

  // Convert everything to minutes
  let totalMinutes = toHH * 60 + toMM + addHH * 60 + addMM;

  // Wrap around 24h
  totalMinutes = totalMinutes % (24 * 60);

  const etaHH = Math.floor(totalMinutes / 60);
  const etaMM = totalMinutes % 60;

  return String(etaHH).padStart(2, "0") + String(etaMM).padStart(2, "0");
}
// --- helpers (keep these where your other helpers are) ---
function fuelDigitsToTenthsOrNull(s) {
  const str = String(s || "").trim();
  if (!str) return null;
  if (/^[.\-]+$/.test(str)) return null;
  if (!/^\d+$/.test(str)) return null;
  return digitsToTenths(str);
}
function diffTenthsOrNull(aTenths, bTenths) {
  if (aTenths == null || bTenths == null) return null;
  return aTenths - bTenths;
}

// ---------------------- PDF rows extraction (X-aware) ----------------------
async function extractPdfRows(arrayBuffer) {
  const pdfjsLib = await loadPdfjs();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  const yTol = 2.0;
  const gapTol = 10;

  const rows = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();

    const linesByY = new Map();
    for (const it of content.items) {
      const str = (it.str ?? "").toString();
      if (!str.trim()) continue;

      const tr = it.transform;
      const x = tr?.[4] ?? 0;
      const y = tr?.[5] ?? 0;

      const yKey = Math.round(y / yTol) * yTol;
      if (!linesByY.has(yKey)) linesByY.set(yKey, []);
      linesByY.get(yKey).push({ x, text: str.trim() });
    }

    const ys = Array.from(linesByY.keys()).sort((a, b) => b - a);
    for (const y of ys) {
      const items = (linesByY.get(y) || []).sort((a, b) => a.x - b.x);

      const merged = [];
      for (const it of items) {
        const last = merged[merged.length - 1];
        if (!last) merged.push({ x: it.x, text: it.text });
        else if (it.x - last.x < gapTol)
          last.text = normalizeSpaces(last.text + " " + it.text);
        else merged.push({ x: it.x, text: it.text });
      }
      rows.push({ page: p, y, cells: merged });
    }

    rows.push({
      page: p,
      y: -999999,
      cells: [{ x: 0, text: "__PAGE_BREAK__" }],
    });
  }
  return rows;
}

// ---------------------- Section slicer ----------------------
function sliceRowsRequestedSection(rows) {
  const startRe = /PIC\s+\.{10,}|\(FPL-/;
  const endStr = "----------------------- ALTERNATE";

  let start = -1;
  let end = -1;

  for (let i = 0; i < rows.length; i++) {
    const t = rowText(rows[i]);
    if (start === -1 && startRe.test(t)) start = i;
    if (start !== -1 && t.includes(endStr)) {
      end = i;
      break;
    }
  }

  if (start === -1 || end === -1 || end <= start) {
    return {
      ok: false,
      error:
        'Could not find start ("PIC ...." or "(FPL-") and/or end marker ("ALTERNATE").',
    };
  }
  return { ok: true, slicedRows: rows.slice(start, end) };
}

// ---------------------- Exact header detection ----------------------
const HEADER_LINE_1 =
  "IDENT  DIST MC  FL  WIND   CMP  TAS/MAC TIME  ETA ATA TBO  FRMG EFB";
const HEADER_LINE_2 =
  "FRQ    DTGO MH      W/S    OAT  G/S     T/TME REV REM ABO  AFOB DSTN";

function normalizeHeaderLine(s) {
  return String(s).toUpperCase().replace(/\s+/g, " ").trim();
}
function findExactTwoLineHeader(rows) {
  const h1 = normalizeHeaderLine(HEADER_LINE_1);
  const h2 = normalizeHeaderLine(HEADER_LINE_2);
  for (let i = 0; i < rows.length - 1; i++) {
    const a = normalizeHeaderLine(rowText(rows[i]));
    const b = normalizeHeaderLine(rowText(rows[i + 1]));
    if (a === h1 && b === h2) return i;
  }
  return -1;
}

// ---------------------- Locked output keys ----------------------
const LOCKED_KEYS = [
  "coord",
  "IDENT",
  "DIST",
  "MC",
  "FL",
  "WIND",
  "CMP",
  "TAS",
  "MAC",
  "TIME",
  "ETA",
  "ATA",
  "TBO",
  "FRMG",
  "EFB",
  "FRQ",
  "DTGO",
  "MH",
  "W_S",
  "OAT",
  "G_S",
  "T_TME",
  "REV",
  "REM",
  "ABO",
  "AFOB",
  "DSTN",
  "__raw",
];

function emptyLockedRow() {
  const o = {};
  for (const k of LOCKED_KEYS) o[k] = "";
  return o;
}
function orderedObject(rec) {
  const o = {};
  for (const k of LOCKED_KEYS) o[k] = rec[k] ?? "";
  return o;
}

// ---------------------- Parse: ONE row per waypoint (continuation absorbed) ----------------------
function parseWaypointsOneRowPerIdent(slicedRows) {
  const headerIdx = findExactTwoLineHeader(slicedRows);
  if (headerIdx === -1) {
    return {
      ok: false,
      error: "Exact 2-line header not found (must match your header exactly).",
    };
  }

  let currentCoord = "";
  let currentIdent = "";

  const acc = new Map(); // ident -> record
  const rawByIdent = new Map(); // ident -> raw lines

  const setAcc = (ident, patch) => {
    const cur = acc.get(ident) || emptyLockedRow();
    acc.set(ident, { ...cur, ...patch });
  };

  // ---- helpers (more universal parsing) ----
  const isFreqToken = (s) => /^\d{1,3}\.\d{2}$/.test(s || "");
  const isIntToken = (s) => /^-?\d+$/.test(s || "");
  const isFLToken = (s) => /^\d{2,3}$/.test(s || "");
  const isMachToken = (s) =>
    /^M\.?\d{2,3}$/i.test(s || "") || /^\.\d{2,3}$/.test(s || "");
  const isWindToken = (s) => /^-?\d{1,3}\/-?\d{1,3}$/.test(s || "");
  const cleanTok = (s) => String(s || "").replace(/[|,;]+$/g, "");
  const isIdentToken = (s) => {
    if (!s) return false;
    if (isIntToken(s)) return false;
    if (/^__PAGE_BREAK__$/i.test(s)) return false;
    const t = cleanTok(s);
    // 3..8 chars typical fixes/airports; allow hyphen
    return /^[A-Z0-9][A-Z0-9-]{2,7}$/i.test(t);
  };

  function classifyMainLine(toks) {
    // IDENT DIST MC FL WIND CMP ...
    const t0 = toks[0] || "";
    const t1 = toks[1] || "";
    if (!isIdentToken(t0)) return false;
    if (!(isIntToken(t1) || /^\d+(\.\d+)?$/.test(t1))) return false;

    // heuristics: look for FL-ish or Mach/TAS-ish in early tokens
    let sawFL = false;
    let sawMachOrTAS = false;

    for (let i = 2; i < Math.min(toks.length, 10); i++) {
      const tok = toks[i] || "";
      if (isFLToken(tok)) sawFL = true;
      if (isMachToken(tok)) sawMachOrTAS = true;
      // TAS often 2-3 digits and appears after CMP, so treat later numeric as TAS-ish
      if (/^\d{2,3}$/.test(tok) && i >= 5) sawMachOrTAS = true;
      if (isWindToken(tok)) {
        // wind is supportive but not required
      }
    }

    return sawFL || sawMachOrTAS;
  }

  function mapLineToFields(t) {
    const toks = t.split(/\s+/).filter(Boolean);
    if (!toks.length) return { type: "other", ident: "", fields: {} };

    // FIR label line
    if (/^FIR\b/i.test(t) || /FIR->/i.test(t)) {
      const fir = extractFirIdent(t);
      return { type: "fir", ident: fir || "", fields: { IDENT: fir || "" } };
    }

    // Frequency line (starts with 116.60)
    if (isFreqToken(toks[0])) {
      return {
        type: "freq",
        ident: "",
        fields: {
          FRQ: toks[0] || "",
          DTGO: toks[1] || "",
          MH: toks[2] || "",
          W_S: toks[3] || "",
          OAT: toks[4] || "",
          G_S: toks[5] || "",
          T_TME: toks[6] || "",
          REV: toks[7] || "",
          REM: toks[8] || "",
          ABO: toks[9] || "",
          AFOB: toks[10] || "",
          DSTN: toks[11] || "",
        },
      };
    }

    // Continuation line (often starts with DTGO)
    if (isIntToken(toks[0]) && toks.length >= 5) {
      const looksLikeMH = /^\d{3}$/.test(toks[1] || "");
      const looksLikeWS = /^-?\d{1,3}$/.test(toks[2] || "");
      if (looksLikeMH || looksLikeWS) {
        const dtgo = toks[0] || "";
        const mh = toks[1] || "";
        const ws = toks[2] || "";
        const oat = toks[3] || "";
        const gs = toks[4] || "";
        const ttme = toks[5] || "";

        const tail = toks.slice(6);
        const dstn = tail.length ? tail[tail.length - 1] : "";

        return {
          type: "cont",
          ident: "",
          fields: {
            DTGO: dtgo,
            MH: mh,
            W_S: ws,
            OAT: oat,
            G_S: gs,
            T_TME: ttme,
            REV: tail[0] || "",
            REM: tail[1] || "",
            ABO: tail[2] || "",
            AFOB: tail[3] || "",
            DSTN: dstn,
          },
        };
      }
    }

    // Main line
    // Main line (starts with IDENT)
    if (classifyMainLine(toks)) {
      const ident = cleanTok(toks[0] || "");
      const dist = toks[1] || "";
      const mc = toks[2] || "";
      const fl = toks[3] || "";
      const wind = toks[4] || "";
      const cmp = toks[5] || "";

      const tail = toks.slice(6);

      // Tail layout you want:
      // TAS MAC TIME ETA ATA TBO FRMG EFB
      // TAS: usually 2-3 digits (e.g. 277)
      // MAC: can be CLB/DES/CRZ/... or a number or M.xxx etc
      // TIME: usually 1-3 digits (e.g. 007)

      const TAS = tail[0] || "";
      const MAC = tail[1] || "";
      const TIME = tail[2] || "";

      const ETA = tail[3] || "";
      const ATA = tail[4] || "";
      const TBO = tail[5] || "";
      const FRMG = tail[6] || "";
      const EFB = tail[7] || "";

      return {
        type: "main",
        ident,
        fields: {
          IDENT: ident,
          DIST: dist,
          MC: mc,
          FL: fl,
          WIND: wind,
          CMP: cmp,

          // ✅ split fields
          TAS: TAS,
          MAC: MAC,
          TIME: TIME,

          ETA: ETA,
          ATA: ATA,
          TBO: TBO,
          FRMG: FRMG,
          EFB: EFB,
        },
      };
    }

    return { type: "other", ident: "", fields: {} };
  }

  // Iterate after header
  for (let i = headerIdx + 2; i < slicedRows.length; i++) {
    const row = slicedRows[i];
    const t = rowText(row);
    if (!t || t === "__PAGE_BREAK__") continue;

    // ✅ DO NOT parse "xxx FIELD" coordinate header lines at all
    // (do not set coord, do not set ident, do not add raw)
    if (/^\s*[A-Z0-9]{1,8}\s+FIELD\b/i.test(t)) continue;

    // Coordinate capture (but not on FIELD lines due to skip above)
    const coord = extractCoordFromText(t);
    if (coord) {
      currentCoord = coord;
      if (isPureCoordRow(t)) continue;
    }

    if (isFormattingOnlyRow(t)) continue;

    const parsed = mapLineToFields(t);

    // Decide ident rules based on line type
    let ident = "";

    if (parsed.type === "main" || parsed.type === "fir") {
      ident = parsed.ident || parsed.fields.IDENT || "";
      if (!ident && parsed.type === "fir") {
        const fir = extractFirIdent(t);
        if (fir) ident = fir;
      }
      if (ident) currentIdent = ident; // update only when we truly saw a new ident
    } else if (parsed.type === "freq" || parsed.type === "cont") {
      // carry-forward ONLY for continuation/freq lines
      ident = currentIdent || "";
    } else {
      // never carry-forward for random lines
      continue;
    }

    if (!ident) continue;

    if (!acc.has(ident)) {
      const base = emptyLockedRow();
      base.coord = currentCoord || "";
      base.IDENT = ident;
      acc.set(ident, base);
      rawByIdent.set(ident, []);
    }

    const cur = acc.get(ident);

    if (!cur.coord && currentCoord) setAcc(ident, { coord: currentCoord });

    // Fill rule: fill empty; replace placeholders with real values
    const patch = {};
    const fields = parsed.fields || {};
    for (const [k, v] of Object.entries(fields)) {
      if (k === "IDENT") continue;
      if (v === undefined) continue;

      if (cur[k] === "" || cur[k] == null) patch[k] = v;
      else if (isPlaceholder(cur[k]) && v && !isPlaceholder(v)) patch[k] = v;
    }

    setAcc(ident, patch);
    rawByIdent.get(ident).push(t);
  }

  const waypoints = [];
  for (const [ident, rec] of acc.entries()) {
    rec.__raw = (rawByIdent.get(ident) || []).join(" | ");
    waypoints.push(orderedObject(rec));
  }

  return { ok: true, waypoints };
}

// ---------------------- ICAO (FPL) parse (Item 13/16 + EET/FIR) ----------------------
function parseIcaoFplFromText(text) {
  const t = String(text || "");

  // ✅ Parse EST LANDING FUEL (anywhere in the document text, not inside the (FPL-...) block)
  // Matches examples:
  // "EST LANDING FUEL 12.3"
  // "EST. LANDING FUEL: 12.3"
  // "EST LANDING FUEL 15"
  let estLandingFuelTenths = null;
  {
    const mFuel = t.match(
      /\bEST\.?\s+LANDING\s+FUEL\b[^0-9]*([0-9]+(?:\.[0-9]+)?)/i
    );
    if (mFuel) {
      const v = parseFloat(mFuel[1]) / 1000;
      if (Number.isFinite(v)) estLandingFuelTenths = Math.round(v * 10) / 10;
    }
  }

  // Existing FPL parse
  const m = t.match(/\(FPL-[\s\S]*?\)/);
  if (!m)
    return {
      ok: false,
      fpl: {
        dep: "",
        dest: "",
        alt: "",
        depTimeHHMM: "",
        eetByFir: {},
        estLandingFuelTenths, // ✅ still return it even if FPL block missing
      },
    };

  const fpl = m[0].replace(/\s+/g, " ").trim();

  // Item 13: -PANC1230-
  const dep13 = fpl.match(/-([A-Z]{4})(\d{4})-/);
  const dep = dep13 ? dep13[1] : "";
  const depTimeHHMM = dep13 ? dep13[2] : "";

  // Item 16: ...-KORD0450 KRFD-
  const item16 = fpl.match(/-([A-Z]{4})(\d{4})\s+([A-Z]{4})-/);
  const dest = item16 ? item16[1] : "";
  const alt = item16 ? item16[3] : "";

  // EET/CZEG0034 KZMP0316
  const eetByFir = {};
  const eet = fpl.match(/EET\/([^-\)]*)/);
  if (eet) {
    const pairs = eet[1].trim().split(/\s+/);
    for (const p of pairs) {
      const mm = p.match(/^([A-Z0-9]{3,6})(\d{4})$/);
      if (mm) eetByFir[mm[1]] = mm[2];
    }
  }

  return {
    ok: true,
    fpl: {
      dep,
      dest,
      alt,
      depTimeHHMM,
      eetByFir,
      estLandingFuelTenths, // ✅ added
      raw: fpl,
    },
  };
}

// Returns tenths (e.g., 12.3 -> 123) or null
function parseEstLandingFuelTenthsFromRows(rows) {
  const rx = /\bEST\.?\s+LANDING\s+FUEL\b[^0-9]*([0-9]+(?:\.[0-9])?)/i;

  for (const r of rows) {
    const t = typeof r === "string" ? r : rowText(r);
    const m = String(t || "").match(rx);
    if (!m) continue;

    const v = parseFloat(m[1]);
    if (isFinite(v)) return Math.round(v * 10);
  }

  return null;
}

// ---------------------- NEW: compute planned/updated/actual + validation + guardrails ----------------------
function computeDerivedLocked(rows, fpl, actualTO, estLandingFuelTenths) {
  const depMin = timeToMinutesFlexible(fpl?.depTimeHHMM);
  const toMin = timeToMinutesFlexible(actualTO?.time); // actual TO HHMM
  const toFuelTenths = uiFuelToTenths(actualTO?.fuel); // actual TO fuel in tenths

  let timeBiasMin = 0;

  // fuel propagation anchor
  let hasFuelAnchor = false;
  let fuelAnchorTboTenths = 0;
  let fuelAnchorActualTenths = 0;

  // prefer explicit param, otherwise fall back to fpl.estLandingFuelTenths
  const estLF = estLandingFuelTenths ?? fpl?.estLandingFuelTenths ?? null;

  function computePlannedETAHHMM_fromActualTO(toMinLocal, t_tme) {
    const tmeMin = tTmeToMinutes(t_tme);
    if (toMinLocal == null || tmeMin == null) return "";
    return minutesToHHMM((toMinLocal + tmeMin) % (24 * 60));
  }

  // Helpers for navlog digits
  function fuelDigitsToTenthsOrNull(s) {
    const str = String(s || "").trim();
    if (!str || /^[.\-]+$/.test(str) || !/^\d+$/.test(str)) return null;
    return digitsToTenths(str); // "1518" -> 1518 tenths
  }
  function diffTenthsOrNull(a, b) {
    if (a == null || b == null) return null;
    return a - b;
  }

  // ✅ TAS_MAC helper (prefer parsed TAS_MAC, else back-compat TAS + MAC)
  function computeTasMac(r) {
    const t = String(r?.TAS_MAC || "").trim();
    if (t) return t;

    const tas = String(r?.TAS || "").trim();
    const mac = String(r?.MAC || "").trim();
    return [tas, mac].filter(Boolean).join(" ").trim();
  }

  return rows.map((r) => {
    // ✅ compute TAS_MAC for this row
    const tasMac = computeTasMac(r);

    // ---------------- TIME ----------------
    const tmeMin = tTmeToMinutes(r.T_TME);
    const baseDepMin = depMin != null ? depMin : toMin;

    const plannedEtaMin =
      baseDepMin != null && tmeMin != null ? baseDepMin + tmeMin : null;

    let updatedEtaMin =
      plannedEtaMin != null ? plannedEtaMin + timeBiasMin : null;

    // manual time anchor: this waypoint becomes updated ETA, and bias shifts subsequent rows
    const actualMin = timeToMinutesFlexible(r._actualTime);
    if (actualMin != null) {
      if (updatedEtaMin != null) timeBiasMin += actualMin - updatedEtaMin;
      updatedEtaMin = actualMin;
    }

    // ETA (planned) and ATA (updated) per your UI rules
    const plannedETAHHMM = computePlannedETAHHMM_fromActualTO(toMin, r.T_TME);
    const updatedETAHHMM =
      updatedEtaMin == null ? "" : minutesToHHMM(updatedEtaMin);

    // ETA_DIFF = planned ETA - updated ETA
    const plannedMin = timeToMinutesFlexible(plannedETAHHMM);
    const updatedMin = timeToMinutesFlexible(updatedETAHHMM);

    const etaDiffMin =
      plannedMin != null && updatedMin != null ? plannedMin - updatedMin : null;

    const etaDiffDisplay =
      etaDiffMin == null ? "-" : `${etaDiffMin > 0 ? "+" : ""}${etaDiffMin}`;

    // ---------------- FUEL ----------------
    // FRMG digits -> tenths (do NOT divide by 10 here; tenthsToUi handles display)
    const plannedFuelTenths = digitsToTenths(r.FRMG); // "1518" -> 1518 (display 151.8)
    const plannedBurnTenths = digitsToTenths(r.TBO);  // digits -> tenths
    const hasTbo = plannedBurnTenths > 0;

    // Updated fuel propagation
    let updatedFuelTenths = 0;
    if (toFuelTenths != null && hasTbo) {
      if (hasFuelAnchor) {
        updatedFuelTenths =
          fuelAnchorActualTenths - (plannedBurnTenths - fuelAnchorTboTenths);
      } else {
        updatedFuelTenths = toFuelTenths - plannedBurnTenths;
      }
    }

    // AFOB = actual fuel entry at waypoint (tenths)
    const afobTenths = uiFuelToTenths(r._actualFuel);

    // Actual burn from TO (tenths)
    const actualBurnTenths =
      toFuelTenths != null && afobTenths != null ? toFuelTenths - afobTenths : null;

    // delta = planned burn - actual burn  (negative = burned more than planned)
    const deltaTenths =
      actualBurnTenths != null && plannedBurnTenths != null
        ? plannedBurnTenths - actualBurnTenths
        : null;

    let deltaColor = "neutral";
    if (deltaTenths != null) {
      if (deltaTenths < 0) deltaColor = "red";
      else if (deltaTenths > 0) deltaColor = "green";
    }

    // Anchor update: if actual fuel entered and TBO exists
    if (afobTenths != null && hasTbo) {
      hasFuelAnchor = true;
      fuelAnchorTboTenths = plannedBurnTenths;
      fuelAnchorActualTenths = afobTenths;
    }

    // ---------------- DERIVED RULES ----------------
    // ABO = actual burn from takeoff = TO fuel - AFOB(actual)
    const aboTenths = diffTenthsOrNull(toFuelTenths, afobTenths);

    // B_DIFF (as you previously used): TBO - ABO
    const tboTenths = fuelDigitsToTenthsOrNull(r.TBO);
    const tboMinusAboTenths = diffTenthsOrNull(tboTenths, aboTenths);

    // EFOA = AFOB(actual) - DSTN(navlog)
    const dstnTenths = fuelDigitsToTenthsOrNull(r.DSTN);
    const efoaRawTenths = diffTenthsOrNull(afobTenths, dstnTenths); // tenths
    const efoaTenths =
      efoaRawTenths == null ? null : Math.round((efoaRawTenths / 10) * 10) / 10; // -> X.Y

    // F_DIFF: AFOB - FRMG
    const frmgTenths = fuelDigitsToTenthsOrNull(r.FRMG);
    const frmgMinusAfobTenths = diffTenthsOrNull(afobTenths, frmgTenths);

    // Compare EFOA to EST LANDING FUEL (both as X.Y)
    const efoaMinusEstLandingTenths =
      efoaTenths != null && estLF != null
        ? Math.round((efoaTenths - estLF) * 10) / 10
        : null;

    let efoaVsEstLandingColor = "neutral";
    if (efoaMinusEstLandingTenths != null) {
      if (efoaMinusEstLandingTenths < 0) efoaVsEstLandingColor = "red";
      else if (efoaMinusEstLandingTenths > 0) efoaVsEstLandingColor = "green";
    }

    return {
      ...r,

      // ✅ optional: also ensure top-level TAS_MAC exists as a column
      TAS_MAC: tasMac,

      _derived: {
        // ✅ derived TAS_MAC for rendering anywhere
        TAS_MAC: tasMac,

        // time
        plannedETAHHMM,
        updatedETAHHMM,
        etaDiffMin,
        etaDiffDisplay,

        // fuel (tenths unless noted)
        plannedFuelTenths,
        plannedBurnTenths,
        updatedFuelTenths,
        actualBurnTenths,

        // deltas
        deltaTenths,
        deltaColor,

        // derived rules
        aboTenths,
        efoaTenths,              // X.Y numeric (not tenths)
        tboMinusAboTenths,       // tenths
        frmgMinusAfobTenths,     // tenths (AFOB - FRMG)

        // landing fuel comparison
        estLandingFuelTenths: estLF,
        efoaMinusEstLandingTenths,
        efoaVsEstLandingColor,
      },
    };
  });
}



// ---------------------- Reducer (INLINE) ----------------------
const initialState = {
  waypoints: [],
  computed: [],
  fpl: { dep: "", dest: "", alt: "", depTimeHHMM: "", eetByFir: {}, raw: "" },
  actualTO: { time: "", fuel: "" },
  currentWaypoint: null,
  modalData: null,
  status: "Upload Flight Release PDF.",
};

function navlogReducer(state, action) {
  switch (action.type) {
    case "SET_STATUS":
      return { ...state, status: action.payload };

    case "SET_PARSED": {
      const { waypoints, fpl } = action.payload;

      const normalized = waypoints.map((w, i) => ({
        id: i,
        ...w,
        _actualTime: w._actualTime || "",
        _actualFuel: w._actualFuel || "",
      }));

      const next = {
        ...state,
        fpl,
        waypoints: normalized,
        modalData: null,
        currentWaypoint: null,
        status: `Parsed ${normalized.length} waypoints (one row each). Enter Takeoff data.`,
      };

      return {
        ...next,
        computed: computeDerivedLocked(next.waypoints, next.fpl, next.actualTO),
      };
    }

    case "SET_TO": {
      const next = { ...state, actualTO: action.payload };

      const firstIdx = next.waypoints.findIndex(
        (w) => !w._actualTime || !w._actualFuel
      );

      return {
        ...next,
        computed: computeDerivedLocked(next.waypoints, next.fpl, next.actualTO),
        currentWaypoint: firstIdx === -1 ? null : firstIdx,
      };
    }

    case "OPEN_MODAL":
      return { ...state, modalData: action.payload };

    case "CLOSE_MODAL":
      return { ...state, modalData: null };

    case "SET_ACTUAL_WP": {
      const { index, time, fuel } = action.payload;

      const waypoints = state.waypoints.map((w, i) =>
        i === index ? { ...w, _actualTime: time, _actualFuel: fuel } : w
      );

      const nextComputed = computeDerivedLocked(
        waypoints,
        state.fpl,
        state.actualTO
      );

      const nextIdx = waypoints.findIndex(
        (w, i) => i > index && (!w._actualTime || !w._actualFuel)
      );

      return {
        ...state,
        waypoints,
        computed: nextComputed,
        modalData: null,
        currentWaypoint: nextIdx === -1 ? null : nextIdx,
      };
    }

    default:
      return state;
  }
}

// ---------------------- Component ----------------------
export default function NavlogTracker() {
  
  const fileRef = useRef(null);

  // ✅ useReducer inline
  const [state, dispatch] = React.useReducer(navlogReducer, initialState);

  // (Optional) keep memo stable if you later add derived selectors
  const computed = state.computed;

  const estLandingFuelUi =
  state.fpl?.estLandingFuelTenths != null
    ? (state.fpl.estLandingFuelTenths)
    : "-";

  // Parse PDF and extract waypoint data
  const handleFileUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    dispatch({ type: "SET_STATUS", payload: "Reading PDF…" });

    try {
      const buf = await file.arrayBuffer();
      const rows = await extractPdfRows(buf);

      const sliced = sliceRowsRequestedSection(rows);
      if (!sliced.ok) {
        dispatch({ type: "SET_STATUS", payload: sliced.error });
        dispatch({
          type: "SET_PARSED",
          payload: { waypoints: [], fpl: initialState.fpl },
        });
        return;
      }

      // Build a text blob for ICAO FPL parse from sliced rows
      const sliceText = sliced.slicedRows
        .map((r) => rowText(r))
        .filter((x) => x && x !== "__PAGE_BREAK__")
        .join("\n");

      const fplRes = parseIcaoFplFromText(sliceText);
      const parsedFpl = fplRes.ok ? fplRes.fpl : initialState.fpl;

      const parsed = parseWaypointsOneRowPerIdent(sliced.slicedRows);
      if (!parsed.ok) {
        dispatch({ type: "SET_STATUS", payload: parsed.error });
        return;
      }

      dispatch({
        type: "SET_PARSED",
        payload: { waypoints: parsed.waypoints, fpl: parsedFpl },
      });
    } catch (err) {
      console.error(err);
      dispatch({
        type: "SET_STATUS",
        payload: `Failed: ${String(err?.message || err)}`,
      });
    }
  };

  const handleTOSubmit = () => {
    if (!state.actualTO.time || !state.actualTO.fuel) return;
    dispatch({ type: "SET_TO", payload: state.actualTO });
  };

  const openWaypointModal = (index) => {
    dispatch({
      type: "OPEN_MODAL",
      payload: {
        index,
        time: state.waypoints[index]?._actualTime || "",
        fuel: state.waypoints[index]?._actualFuel || "",
      },
    });
  };

  const handleWaypointSubmit = () => {
    if (!state.modalData || !state.modalData.time || !state.modalData.fuel)
      return;

    const { index, time, fuel } = state.modalData;
    dispatch({ type: "SET_ACTUAL_WP", payload: { index, time, fuel } });
  };

  const displayPlannedTime = (r) => {
    // FMC provided numeric ETA HHMM
    if (r.ETA && /^\d{3,4}$/.test(r.ETA)) return hhmmToDisplayHHdotMM(r.ETA);
    return r.ETA || "-";
  };

  const displayPlannedFuel = (r) => {
    // LOCKED: planned fuel = FRMG (tenths), show as X.Y
    const tenths = digitsToTenths(r.FRMG);
    return tenths ? tenthsToUi(tenths) : "-";
  };

  const displayUpdatedEta = (r) => {
    const hhmm = r._derived?.updatedETAHHMM || "";
    return hhmm ? hhmmToDisplayHHdotMM(hhmm) : "-";
  };

  const displayPlannedEta = (r) => {
    const hhmm = r._derived?.plannedETAHHMM || "";
    return hhmm ? hhmmToDisplayHHdotMM(hhmm) : displayPlannedTime(r);
  };

  const displayUpdatedFuel = (r) => {
    const tenths = r._derived?.updatedFuelTenths ?? 0;
    if (!tenths) return "-";
    return tenthsToUi(tenths);
  };

  const fplNumber = (() => {
    const raw = state.fpl?.raw || "";
    const m = raw.match(/\(FPL-([A-Z0-9]+)-/i);
    return m ? m[1] : "";
  })();

  const displayBurnTenths = (tenths) => {
    if (!tenths) return "-";
    return tenthsToUi(tenths);
  };

  return (
    <div
      style={{
        padding: "20px",
        fontFamily: "Arial, sans-serif",
        maxWidth: "1400px",
        margin: "0 auto",
      }}
    >
      <h1 style={{ textAlign: "center", color: "#333" }}>
        ✈️ Navlog Fuel Tracker
      </h1>

      <div
        style={{
          marginBottom: 14,
          padding: 12,
          background: "#fff",
          border: "1px solid #ddd",
          borderRadius: 8,
        }}
      >
        <b>Status:</b> {state.status}
        {state.fpl?.depTimeHHMM ? (
          <div style={{ marginTop: 6, fontSize: 12, color: "#555" }}>
            FPL: DEP <span style={mono}>{state.fpl.dep || "-"}</span> @{` `}
            <span style={mono}>{state.fpl.depTimeHHMM}</span> → DEST{" "}
            <span style={mono}>{state.fpl.dest || "-"}</span> ALT{" "}
            <span style={mono}>{state.fpl.alt || "-"}</span>
          </div>
        ) : null}
      </div>

      {/* File Upload */}
      <div
        style={{
          marginBottom: "30px",
          padding: "20px",
          backgroundColor: "#f5f5f5",
          borderRadius: "8px",
        }}
      >
        <label
          style={{ display: "block", marginBottom: "10px", fontWeight: "bold" }}
        >
          Upload Flight Release PDF:
        </label>
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf"
          onChange={handleFileUpload}
          style={{ padding: "10px" }}
        />
      </div>

      {/* Actual Takeoff Data */}
  {/* Actual Takeoff Data */}
{state.waypoints.length > 0 && (
  <div
    style={{
      marginBottom: "30px",
      padding: "20px",
      backgroundColor: "#e3f2fd",
      borderRadius: "8px",
    }}
  >
   <div style={{ marginBottom: "10px" }}>
  {fplNumber && (
    <div
      style={{
        fontSize: "14px",
        fontWeight: "bold",
        marginBottom: "4px",
        ...mono,
      }}
    >
      FPL: {fplNumber}
    </div>
  )}

  <h3>🛫 Actual Takeoff Data</h3>
</div>


    <div
      style={{
        display: "flex",
        gap: "20px",
        alignItems: "flex-end",
        flexWrap: "wrap",
      }}
    >
      {/* Actual TO Time */}
      <div>
        <label style={{ display: "block", marginBottom: "5px" }}>
          Actual TO Time (HHMM or HH.MM):
        </label>
        <input
          type="text"
          placeholder="1842 or 18.42"
          value={state.actualTO.time}
          onChange={(e) =>
            dispatch({
              type: "SET_TO",
              payload: { ...state.actualTO, time: e.target.value },
            })
          }
          style={{
            padding: "8px",
            fontSize: "16px",
            width: "160px",
            ...mono,
          }}
        />
      </div>

      {/* Actual TO Fuel */}
      <div>
        <label style={{ display: "block", marginBottom: "5px" }}>
          Actual TO Fuel:
        </label>
        <input
          type="text"
          placeholder="152.0"
          value={state.actualTO.fuel}
          onChange={(e) =>
            dispatch({
              type: "SET_TO",
              payload: { ...state.actualTO, fuel: e.target.value },
            })
          }
          style={{
            padding: "8px",
            fontSize: "16px",
            width: "160px",
            ...mono,
          }}
        />
      </div>

      {/* Estimated Landing Fuel */}
      <div>
  <label style={{ display: "block", marginBottom: "5px" }}>
    Estimated Landing Fuel:
  </label>

  <div
    style={{
      padding: "8px 0",
      fontSize: "18px",
      fontWeight: "bold",
      ...mono,
    }}
  >
    {estLandingFuelUi}
  </div>
</div>


      {/* Set Takeoff Button */}
      <button
        onClick={handleTOSubmit}
        style={{
          padding: "10px 20px",
          backgroundColor: "#4CAF50",
          color: "white",
          border: "none",
          borderRadius: "4px",
          cursor: "pointer",
          fontSize: "16px",
        }}
      >
        Set Takeoff
      </button>
    </div>

    <div style={{ marginTop: 10, fontSize: 12, color: "#555" }}>
      Planned ETA = <span style={mono}>FPL Item 13</span> +{" "}
      <span style={mono}>T/TME</span>. Planned fuel ={" "}
      <span style={mono}>FRMG</span>. Planned burn ={" "}
      <span style={mono}>TBO</span>. Updated fuel ={" "}
      <span style={mono}>TO − TBO</span>.
    </div>
  </div>
)}


      {/* Waypoints Table */}
      {state.waypoints.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              backgroundColor: "white",
              boxShadow: "0 2px 4px rgba(0,0,0,0.1)",
            }}
          >
<thead>
  {/* ROW 1 */}
  <tr style={{ backgroundColor: "#333", color: "white" }}>
    <th style={headerStyle} colSpan={8}>COORDS</th>
    <th style={headerStyle}>ETA_DIFF</th>
    <th style={headerStyle} colSpan={5}></th>
    <th style={headerStyle} rowSpan={4}>Action</th>
  </tr>

  {/* ROW 2 — Main navlog */}
  <tr style={{ backgroundColor: "#333", color: "white" }}>
    <th style={headerStyle}>IDENT</th>
    <th style={headerStyle}>DIST</th>
    <th style={headerStyle}>MC</th>
    <th style={headerStyle}>FL</th>
    <th style={headerStyle}>WIND</th>
    <th style={headerStyle}>CMP</th>
    <th style={headerStyle}>TAS/MAC</th>
    <th style={headerStyle}>TIME</th>

    <th style={headerStyle}>ETA</th>

    <th style={headerStyle}>ATA</th>
    <th style={headerStyle}>TBO</th>
    <th style={headerStyle}>FRMG</th>
    <th style={headerStyle}>EFB</th>
    <th style={headerStyle}></th>
  </tr>

  {/* ROW 3 — Second navlog */}
  <tr style={{ backgroundColor: "#333", color: "white" }}>
    <th style={headerStyle}>FRQ</th>
    <th style={headerStyle}>DTGO</th>
    <th style={headerStyle}>MH</th>
    <th style={headerStyle}></th>
    <th style={headerStyle}>W/S</th>
    <th style={headerStyle}>OAT</th>
    <th style={headerStyle}>G/S</th>
    <th style={headerStyle}>T/TME</th>

    <th style={headerStyle}>REV</th>

    <th style={headerStyle}>REM</th>
    <th style={headerStyle}>ABO</th>
    <th style={headerStyle}>AFOB</th>
    <th style={headerStyle}>DSTN</th>
    <th style={headerStyle}>EFOA</th>
  </tr>

  {/* ROW 4 — Diff row (ONLY B_DIFF & F_DIFF) */}
  <tr style={{ backgroundColor: "#333", color: "white" }}>
    {/* Blank cells until ABO column */}
    <th style={headerStyle}></th>
    <th style={headerStyle}></th>
    <th style={headerStyle}></th>
    <th style={headerStyle}></th>
    <th style={headerStyle}></th>
    <th style={headerStyle}></th>
    <th style={headerStyle}></th>
    <th style={headerStyle}></th>
    <th style={headerStyle}></th>
    <th style={headerStyle}></th>

    {/* Under ABO */}
    <th style={headerStyle}>B_DIFF</th>

    {/* Under AFOB */}
    <th style={headerStyle}>F_DIFF</th>

    {/* Remaining blanks */}
    <th style={headerStyle}></th>
    <th style={headerStyle}></th>
  </tr>
</thead>




<tbody>
  {computed.map((wp, idx) => {
    const isNext = idx === state.currentWaypoint;
    const isPast =
      state.currentWaypoint != null && idx < state.currentWaypoint;

    const rowBg = isNext ? "#fff9c4" : isPast ? "#f0f0f0" : "white";

    const hasActual =
      state.waypoints[idx]?._actualTime &&
      state.waypoints[idx]?._actualFuel;

    // ✅ use existing derived flags (already part of tbody logic in your original)
    const flags = wp._derived?.flags || [];

    // ✅ "updated ETA exists" gate driven by flags (if you set one) + value
    // If you do NOT currently set "NO_UPDATED_ETA", this still works because includes() will be false.
    const hasUpdatedETA =
      !!wp._derived?.updatedETAHHMM && !flags.includes("NO_UPDATED_ETA");

    // ETA_DIFF = planned - updated (minutes)
    const plannedMin = timeToMinutesFlexible(wp._derived?.plannedETAHHMM);
    const updatedMin = timeToMinutesFlexible(wp._derived?.updatedETAHHMM);

    const etaDiffMin =
      plannedMin != null && updatedMin != null ? plannedMin - updatedMin : null;

    const etaDiffDisplay =
      etaDiffMin == null ? "-" : `${etaDiffMin > 0 ? "+" : ""}${etaDiffMin}`;

      const bDiff =
      hasActual && wp._derived?.tboMinusAboTenths != null
        ? (wp._derived.tboMinusAboTenths / 10).toFixed(1)
        : "-";
    
    const fDiff =
      hasActual && wp._derived?.frmgMinusAfobTenths != null
        ? (wp._derived.frmgMinusAfobTenths / 10).toFixed(1)
        : "-";
    
    // ✅ Hide EFOA if NO updated ETA (gate via flags/value)
    const hasActionEntry = !!state.waypoints[idx]?._actualFuel;

    const efoa =
      hasActionEntry && wp._derived?.efoaTenths != null
        ? Number(wp._derived.efoaTenths).toFixed(1)
        : "-";
    

    return (
      <React.Fragment key={`${wp.IDENT}-${idx}`}>
        {/* ROW 1 — COORDS + ETA_DIFF */}
        <tr style={{ backgroundColor: rowBg, borderBottom: "1px solid #ddd" }}>
          <td style={cellStyle}>{wp.coord || "-"}</td>
          <td colSpan={7}></td>

          {/* ETA_DIFF column */}
          <td style={cellStyle}>{hasActual ? etaDiffDisplay : "-"}</td>

          <td colSpan={6}></td>
        </tr>

        {/* ROW 2 — MAIN NAVLOG */}
        <tr style={{ backgroundColor: rowBg, borderBottom: "1px solid #ddd" }}>
          <td style={cellStyle}>
            <strong>{wp.IDENT || "-"}</strong>
          </td>
          <td style={cellStyle}>{wp.DIST || "-"}</td>
          <td style={cellStyle}>{wp.MC || "-"}</td>
          <td style={cellStyle}>{wp.FL || "-"}</td>
          <td style={cellStyle}>{wp.WIND || "-"}</td>
          <td style={cellStyle}>{wp.CMP || "-"}</td>
          <td style={cellStyle}>{wp.TAS_MAC || "-"}</td>


          <td style={cellStyle}>{wp.TIME || "-"}</td>

          {/* ETA (planned) */}
          <td style={cellStyle}>{displayPlannedEta(wp)}</td>

          {/* ATA = updated ETA */}
          <td style={cellStyle}>
  {hasActual && wp._derived?.updatedETAHHMM
    ? hhmmToDisplayHHdotMM(wp._derived.updatedETAHHMM)
    : "-"}
</td>


          {/* TBO */}
          <td style={cellStyle}>{wp.TBO || "-"}</td>

          {/* FRMG (planned fuel) */}
          <td style={cellStyle}>
            {wp._derived?.plannedFuelTenths != null
              ? tenthsToUi(wp._derived.plannedFuelTenths)
              : "-"}
          </td>

          {/* EFB = planned burn (per your current mapping) */}
          <td style={cellStyle}>
            {wp._derived?.plannedBurnTenths != null
              ? tenthsToUi(wp._derived.plannedBurnTenths)
              : "-"}
          </td>

          <td style={cellStyle}></td>
          <td style={cellStyle}></td>
        </tr>

        {/* ROW 3 — SECOND NAVLOG */}
        <tr style={{ backgroundColor: rowBg, borderBottom: "1px solid #ddd" }}>
          <td style={cellStyle}>{wp.FRQ || "-"}</td>
          <td style={cellStyle}>{wp.DTGO || "-"}</td>
          <td style={cellStyle}>{wp.MH || "-"}</td>
          <td style={cellStyle}></td>
          <td style={cellStyle}>{wp.W_S || "-"}</td>
          <td style={cellStyle}>{wp.OAT || "-"}</td>
          <td style={cellStyle}>{wp.G_S || "-"}</td>
          <td style={cellStyle}>{wp.T_TME || "-"}</td>

          {/* REV = MM from ATA */}
          <td style={cellStyle}>
            {hasUpdatedETA ? hhmmToDisplayHHdotMM(wp._derived.updatedETAHHMM): "-"}
          </td>

          <td style={cellStyle}>{wp.REM || "-"}</td>

          {/* ABO = actual burn from TO */}
          <td style={cellStyle}>
            {wp._derived?.aboTenths != null ? tenthsToUi(wp._derived.aboTenths) : "-"}
          </td>

          {/* AFOB (actual fuel entry or navlog AFOB) */}
          <td style={cellStyle}>
            {state.waypoints[idx]?._actualFuel || wp.AFOB || "-"}
          </td>

          <td style={cellStyle}>{wp.DSTN || "-"}</td>

          {/* EFOA hidden unless updated ETA */}
          <td style={cellStyle}>{efoa}</td>

          {/* Action */}
          <td style={cellStyle}>
            <button
              onClick={() => openWaypointModal(idx)}
              disabled={!state.actualTO.time || !state.actualTO.fuel}
              style={{
                padding: "6px 12px",
                backgroundColor: isNext ? "#2196F3" : "#757575",
                color: "white",
                border: "none",
                borderRadius: "4px",
                cursor:
                  state.actualTO.time && state.actualTO.fuel
                    ? "pointer"
                    : "not-allowed",
                opacity: state.actualTO.time && state.actualTO.fuel ? 1 : 0.5,
              }}
            >
              {hasActual ? "✏️ Edit" : "➕ Enter"}
            </button>
          </td>
        </tr>

        {/* ROW 4 — B_DIFF / F_DIFF */}
        <tr style={{ backgroundColor: rowBg, borderBottom: "2px solid #ddd" }}>
          <td colSpan={10}></td>
          <td style={cellStyle}>{bDiff}</td>
          <td style={cellStyle}>{fDiff}</td>
          <td colSpan={3}></td>
        </tr>
      </React.Fragment>
    );
  })}
</tbody>



          </table>

          {/* Full array JSON (debug) */}
          <div style={{ marginTop: 18 }}>
            <h3 style={{ margin: "10px 0" }}>Computed JSON (full array)</h3>
            <pre
              style={{
                ...mono,
                fontSize: 11,
                background: "#f7f7f7",
                padding: 12,
                borderRadius: 8,
                maxHeight: 520,
                overflow: "auto",
              }}
            >
              {JSON.stringify(state.computed, null, 2)}
            </pre>
          </div>
        </div>
      )}

      {/* Modal */}
      {state.modalData !== null && state.waypoints[state.modalData.index] && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: "rgba(0,0,0,0.5)",
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            zIndex: 1000,
          }}
        >
          <div
            style={{
              backgroundColor: "white",
              padding: "30px",
              borderRadius: "8px",
              boxShadow: "0 4px 6px rgba(0,0,0,0.1)",
              minWidth: "420px",
              maxWidth: "520px",
            }}
          >
            <h3>
              Enter Actual Data for{" "}
              {state.waypoints[state.modalData.index].IDENT}
            </h3>

            <div style={{ marginBottom: "14px", fontSize: 12, color: "#555" }}>
              Planned ETA:{" "}
              <span style={mono}>
                {displayPlannedEta(state.computed[state.modalData.index])}
              </span>{" "}
              | Updated ETA:{" "}
              <span style={mono}>
                {displayUpdatedEta(state.computed[state.modalData.index])}
              </span>
              <br />
              Planned Fuel:{" "}
              <span style={mono}>
                {displayPlannedFuel(state.computed[state.modalData.index])}
              </span>{" "}
              | Planned Burn:{" "}
              <span style={mono}>
                {displayBurnTenths(
                  state.computed[state.modalData.index]._derived
                    ?.plannedBurnTenths || 0
                )}
              </span>
              <br />
              Updated Fuel:{" "}
              <span style={mono}>
                {displayUpdatedFuel(state.computed[state.modalData.index])}
              </span>{" "}
              | DSTN:{" "}
              <span style={mono}>
                {state.computed[state.modalData.index].DSTN || "-"}
              </span>
            </div>

            <div style={{ marginBottom: "20px" }}>
              <label style={{ display: "block", marginBottom: "5px" }}>
                Actual Time (HHMM or HH.MM):
              </label>
              <input
                type="text"
                placeholder="1251 or 12.51"
                value={state.modalData.time}
                onChange={(e) =>
                  dispatch({
                    type: "OPEN_MODAL",
                    payload: { ...state.modalData, time: e.target.value },
                  })
                }
                style={{
                  padding: "8px",
                  fontSize: "16px",
                  width: "100%",
                  ...mono,
                }}
              />
            </div>

            <div style={{ marginBottom: "20px" }}>
              <label style={{ display: "block", marginBottom: "5px" }}>
                Actual Fuel:
              </label>
              <input
                type="text"
                placeholder="150.4"
                value={state.modalData.fuel}
                onChange={(e) =>
                  dispatch({
                    type: "OPEN_MODAL",
                    payload: { ...state.modalData, fuel: e.target.value },
                  })
                }
                style={{
                  padding: "8px",
                  fontSize: "16px",
                  width: "100%",
                  ...mono,
                }}
              />
            </div>

            <details style={{ marginBottom: 18 }}>
              <summary style={{ cursor: "pointer", ...mono, fontSize: 12 }}>
                Show raw/navlog lines
              </summary>
              <pre
                style={{
                  whiteSpace: "pre-wrap",
                  fontSize: 11,
                  padding: 10,
                  background: "#f7f7f7",
                  border: "1px solid #eee",
                  borderRadius: 8,
                  ...mono,
                }}
              >
                {state.computed[state.modalData.index].__raw}
              </pre>
              <div
                style={{ marginTop: 8, fontSize: 11, color: "#555", ...mono }}
              >
                FPL raw: {state.fpl?.raw || "(not found)"}
              </div>
            </details>

            <div
              style={{
                display: "flex",
                gap: "10px",
                justifyContent: "flex-end",
              }}
            >
              <button
                onClick={() => dispatch({ type: "CLOSE_MODAL" })}
                style={{
                  padding: "10px 20px",
                  backgroundColor: "#757575",
                  color: "white",
                  border: "none",
                  borderRadius: "4px",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleWaypointSubmit}
                style={{
                  padding: "10px 20px",
                  backgroundColor: "#4CAF50",
                  color: "white",
                  border: "none",
                  borderRadius: "4px",
                  cursor: "pointer",
                }}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {state.waypoints.length === 0 && (
        <div
          style={{
            textAlign: "center",
            padding: "60px",
            color: "#999",
            fontSize: "18px",
          }}
        >
          📄 Upload a flight release PDF to get started
        </div>
      )}
    </div>
  );
}
