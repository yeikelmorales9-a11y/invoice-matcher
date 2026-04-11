import { useState, useCallback, useRef } from "react";
import * as XLSX from "xlsx-js-style";
import * as pdfjsLib from "pdfjs-dist";

pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.mjs`;

const API_URL = "/api/openai";

// ── PDF ───────────────────────────────────────────────────────────────────────
async function pdfToText(file) {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
  let text = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    for (const item of content.items) {
      if (!item.str) continue;
      text += item.str + (item.hasEOL ? "\n" : " ");
    }
    text += "\n";
  }
  return text.trim();
}

async function pdfPagesToImages(file) {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
  const images = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 2.0 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    images.push(canvas.toDataURL("image/jpeg", 0.85).split(",")[1]);
  }
  return images;
}

// ── Inventario Excel ──────────────────────────────────────────────────────────
function readInventory(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = (e) => {
      try {
        const wb = XLSX.read(e.target.result, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
        let headerIdx = -1;
        for (let i = 0; i < Math.min(raw.length, 10); i++) {
          if (
            raw[i].some((c) => String(c).toLowerCase().includes("nombre")) &&
            raw[i].some((c) => String(c).toLowerCase().includes("codigo"))
          ) { headerIdx = i; break; }
        }
        if (headerIdx === -1) { rej(new Error("No se encontro encabezado con 'nombre' y 'codigo'")); return; }
        const headers = raw[headerIdx].map((h) => String(h).trim().toLowerCase());
        const nameIdx  = headers.findIndex((h) => h.includes("nombre"));
        const codeIdx  = headers.findIndex((h) => h.includes("codigo"));
        const umIdx    = headers.findIndex((h) => h.includes("unidad manejo") || h === "um");
        const usubIdx  = headers.findIndex((h) => h.includes("unidad subpartida") || h.includes("subpartida"));
        const items = [];
        for (let i = headerIdx + 1; i < raw.length; i++) {
          const nombre = String(raw[i][nameIdx] || "").trim();
          const codigo = String(raw[i][codeIdx] || "").trim();
          if (!nombre || !codigo) continue;
          items.push({
            nombre: nombre.toUpperCase(),
            codigo,
            unidad_manejo:     umIdx   >= 0 ? String(raw[i][umIdx]   || "").trim() : "",
            unidad_subpartida: usubIdx >= 0 ? String(raw[i][usubIdx] || "").trim() : "",
          });
        }
        res(items);
      } catch (err) { rej(err); }
    };
    r.onerror = () => rej(new Error("Error leyendo inventario"));
    r.readAsArrayBuffer(file);
  });
}

// ── TF-IDF ────────────────────────────────────────────────────────────────────
function normalize(str) {
  return str.toUpperCase()
    .replace(/(\d+)\s*[Xx]\s*(\d+)/g, "$1 X $2")  // "3X14" / "3x14" / "3 x 14" → "3 X 14"
    .replace(/[.,\-()_[\]"'/]/g, " ");
}

function tokenize(str) {
  return normalize(str).split(/\s+/).filter(w => w.length > 0);
}

function buildIDF(invItems) {
  const df = {}, N = invItems.length;
  for (const item of invItems) {
    const tokens = new Set(tokenize(item.nombre));
    for (const t of tokens) df[t] = (df[t] || 0) + 1;
  }
  const idf = {};
  for (const [t, count] of Object.entries(df)) idf[t] = Math.log((N + 1) / (count + 1)) + 1;
  return idf;
}

function extractMeasures(str) {
  const upper = normalize(str), found = new Set();
  // fracciones tipo "1 1/2"
  for (const m of upper.matchAll(/\b(\d+)\s+(\d+\/\d+)\b/g)) found.add(m[1] + " " + m[2]);
  // fracciones solas tipo "3/4"
  for (const m of upper.matchAll(/\b(\d+\/\d+)\b/g)) found.add(m[1]);
  // dimensiones decimales tipo "0.55" "1.22"
  for (const m of upper.matchAll(/\b(\d+[.,]\d+)\b/g)) found.add(m[1].replace(",", "."));
  // numeros enteros pequeños (tamaños tipicos hasta 24)
  for (const m of upper.matchAll(/\b(\d+)\b/g)) if (parseInt(m[1]) <= 24) found.add(m[1]);
  return found;
}

function getTopCandidates(invItems, query, idf, N = 8) {
  const queryTokens = tokenize(query), queryMeasures = extractMeasures(query);
  const scored = invItems.map(item => {
    const itemTokens = tokenize(item.nombre);
    const itemSet = new Set(itemTokens), querySet = new Set(queryTokens);
    let score = 0;
    for (const t of queryTokens) if (itemSet.has(t)) score += (idf[t] || 1);
    for (const t of itemTokens)  if (querySet.has(t)) score += (idf[t] || 1) * 0.5;
    const itemMeasures = extractMeasures(item.nombre);
    if (queryMeasures.size > 0 && itemMeasures.size > 0) {
      const hasCommon = [...queryMeasures].some(m => itemMeasures.has(m));
      if (!hasCommon) score *= 0.05;
    }
    return { item, score };
  });
  return scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, N).map(s => s.item);
}

// ── GPT-4o Match ──────────────────────────────────────────────────────────────
async function aiPickBestMatch(descripcionFactura, cantidadFactura, candidates) {
  if (!candidates.length) return null;
  const candidateList = candidates.map((c, i) =>
    `${i + 1}. [${c.codigo}] ${c.nombre}` +
    (c.unidad_manejo     ? ` | UM Apollo: ${c.unidad_manejo}`        : "") +
    (c.unidad_subpartida ? ` | U.Sub: ${c.unidad_subpartida}` : "")
  ).join("\n");

  const prompt = `Eres un experto en materiales de construccion y plomeria en Colombia.

Item de factura:
- Descripcion: "${descripcionFactura}"
- Cantidad en factura: ${cantidadFactura}

Candidatos del inventario:
${candidateList}

INSTRUCCIONES:
1. Elige el candidato correcto segun tipo, medidas exactas, material y marca.
2. Usa la Unidad de Manejo (UM Apollo) y Unidad de Subpartida para validar o ajustar la cantidad.
   Ejemplo: si UM es "CAJA x12" y la factura dice 24 unidades => cantidad_ajustada = 2.
   Si UM es "UND" o "UNIDAD" la cantidad no cambia.
3. Estima el peso unitario en KG del producto seleccionado.
4. Si ningun candidato corresponde al producto, responde match: 0.

Responde SOLO con este JSON sin markdown:
{"match":N,"confidence":"high"|"medium"|"low","cantidad_ajustada":N_O_NULL,"nota_cantidad":"texto_o_null","peso_kg":N_O_NULL}`;

  const resp = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o", max_tokens: 150, temperature: 0, messages: [{ role: "user", content: prompt }] }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error?.message || "Error en API de matching");
  const raw = data.choices[0].message.content.trim().replace(/```json|```/g, "");
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.match || parsed.match === 0 || !candidates[parsed.match - 1]) return null;
    return {
      ...candidates[parsed.match - 1],
      confidence:        parsed.confidence,
      cantidad_ajustada: parsed.cantidad_ajustada ?? null,
      nota_cantidad:     parsed.nota_cantidad ?? null,
      peso_kg:           parsed.peso_kg ?? null,
    };
  } catch { return null; }
}

// ── Helpers de formato ────────────────────────────────────────────────────────
function fmtNum(val, dec = 6) {
  if (val == null || val === "") return "";
  return Number(val).toFixed(dec).replace(".", ",");
}

// ── Export Excel ──────────────────────────────────────────────────────────────
function toNum(val) {
  if (val == null || val === "") return "";
  const n = Number(val);
  return isNaN(n) ? "" : n;
}

function exportXLSX(rows) {
  const HEADERS = ["Nombre", "Codigo", "Peso Bruto", "Peso Neto", "Cantidad", "Valor Unitario"];

  const dataRows = rows.map(r => {
    const cant = r.cantidad_ajustada ?? r.cantidad;
    return [
      r.nombre_sistema || r.desc_factura || "",
      r.codigo || "",
      toNum(r.peso_total),
      toNum(r.peso_total),
      toNum(cant),
      toNum(r.valor_usd),
    ];
  });

  const wsData = [HEADERS, ...dataRows];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws["!cols"] = [{wch:38},{wch:14},{wch:14},{wch:14},{wch:10},{wch:18}];
  XLSX.utils.book_append_sheet(wb, ws, "Cruce Factura");
  XLSX.writeFile(wb, "cruce_factura.xlsx");
}

// ── UI Components ─────────────────────────────────────────────────────────────
function DropZone({ label, accept, onFile, file, icon }) {
  const ref = useRef();
  const [drag, setDrag] = useState(false);
  return (
    <div
      onClick={() => ref.current.click()}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) onFile(f); }}
      style={{
        cursor: "pointer", borderRadius: 16,
        border: `2px dashed ${drag ? "#6366f1" : file ? "#22c55e" : "rgba(255,255,255,0.2)"}`,
        padding: "28px 16px", display: "flex", flexDirection: "column", alignItems: "center", gap: 10,
        background: drag ? "rgba(99,102,241,0.15)" : file ? "rgba(34,197,94,0.1)" : "rgba(255,255,255,0.05)",
        transition: "all 0.2s", backdropFilter: "blur(4px)",
      }}
    >
      <input ref={ref} type="file" accept={accept} style={{ display: "none" }} onChange={(e) => { if (e.target.files[0]) onFile(e.target.files[0]); }} />
      <span style={{ fontSize: 36 }}>{file ? "✅" : icon}</span>
      <span style={{ fontSize: 13, fontWeight: 600, color: file ? "#4ade80" : "rgba(255,255,255,0.7)", textAlign: "center", lineHeight: 1.4 }}>
        {file ? file.name : label}
      </span>
      {file && <span style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", background: "rgba(255,255,255,0.08)", padding: "2px 10px", borderRadius: 999 }}>Clic para cambiar</span>}
    </div>
  );
}

function StatusBadge({ status }) {
  const cfg = {
    found:    { bg: "#dcfce7", text: "#15803d", border: "#86efac", icon: "✓", label: "Encontrado" },
    verify:   { bg: "#fef9c3", text: "#a16207", border: "#fde047", icon: "⚠", label: "Verificar" },
    notfound: { bg: "#fee2e2", text: "#b91c1c", border: "#fca5a5", icon: "✗", label: "No encontrado" },
  };
  const c = cfg[status] || cfg.notfound;
  return (
    <span style={{ padding: "3px 10px", borderRadius: 999, fontSize: 11, fontWeight: 700, background: c.bg, color: c.text, border: `1px solid ${c.border}`, whiteSpace: "nowrap" }}>
      {c.icon} {c.label}
    </span>
  );
}

function StatCard({ icon, label, value, color, bg, border }) {
  return (
    <div style={{ background: bg, border: `1.5px solid ${border}`, borderRadius: 14, padding: "12px 20px", display: "flex", alignItems: "center", gap: 12, minWidth: 130 }}>
      <span style={{ fontSize: 22 }}>{icon}</span>
      <div>
        <div style={{ fontSize: 24, fontWeight: 800, color, lineHeight: 1 }}>{value}</div>
        <div style={{ fontSize: 11, color, fontWeight: 600, marginTop: 2, opacity: 0.8 }}>{label}</div>
      </div>
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [pdfFile,   setPdfFile]   = useState(null);
  const [xlsxFile,  setXlsxFile]  = useState(null);
  const [tasa,      setTasa]      = useState("");
  const [loading,   setLoading]   = useState(false);
  const [progress,  setProgress]  = useState("");
  const [progIdx,   setProgIdx]   = useState(0);
  const [progTotal, setProgTotal] = useState(0);
  const [results,   setResults]   = useState(null);
  const [error,     setError]     = useState("");

  const canRun = pdfFile && xlsxFile && tasa && Number(tasa) > 0 && !loading;

  const run = useCallback(async () => {
    setLoading(true); setError(""); setResults(null); setProgIdx(0); setProgTotal(0);
    try {
      const tasaNum = parseFloat(tasa);

      setProgress("Leyendo inventario...");
      const inventory = await readInventory(xlsxFile);
      const idf = buildIDF(inventory);

      setProgress("Extrayendo items de la factura...");
      const pdfText = await pdfToText(pdfFile);
      const isScanned = pdfText.trim().length < 50;

      const INSTRUCCIONES = `INSTRUCCIONES:
- cantidad: numero (puede ser decimal si es por metro/kg)
- valor_unitario: numero en PESOS COP (si ves subtotal divide entre cantidad)
- descripcion: nombre completo con medidas y material
Devuelve SOLO JSON valido con dobles comillas:
{"items":[{"descripcion":"...","cantidad":N,"valor_unitario":N}]}`;

      let extractMessages;
      if (isScanned) {
        setProgress("PDF escaneado — analizando con vision IA...");
        const pageImages = await pdfPagesToImages(pdfFile);
        extractMessages = [{
          role: "user",
          content: [
            { type: "text", text: `Analiza esta factura escaneada y extrae TODOS los items.\n${INSTRUCCIONES}` },
            ...pageImages.map(b64 => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } })),
          ],
        }];
      } else {
        extractMessages = [{
          role: "user",
          content: `Analiza este texto de factura y extrae TODOS los items.\n${INSTRUCCIONES}\n\nTexto:\n${pdfText}`,
        }];
      }

      const extractResp = await fetch(API_URL, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", max_tokens: 8192, temperature: 0, messages: extractMessages }),
      });
      const extractData = await extractResp.json();
      if (!extractResp.ok) throw new Error(`API ${extractResp.status} - ${extractData.error?.message || JSON.stringify(extractData)}`);

      const rawText = extractData.choices[0].message.content.trim().replace(/```json|```/g, "").trim();
      if (!rawText.startsWith("{")) throw new Error(`GPT no devolvio JSON. Respuesta: ${rawText.substring(0, 200)}`);
      const parsed = JSON.parse(rawText);
      const invoiceItems = parsed.items || [];

      setProgTotal(invoiceItems.length);
      const rows = [];
      for (let idx = 0; idx < invoiceItems.length; idx++) {
        const inv = invoiceItems[idx];
        setProgIdx(idx + 1);
        setProgress(`Cruzando item ${idx + 1} de ${invoiceItems.length}`);

        const vr_usd = inv.valor_unitario ? +(inv.valor_unitario / tasaNum).toFixed(6) : null;
        const candidates = getTopCandidates(inventory, inv.descripcion, idf, 5);

        let match = null, status = "notfound";
        if (candidates.length > 0) {
          match = await aiPickBestMatch(inv.descripcion, inv.cantidad, candidates);
          if (match) status = match.confidence === "high" ? "found" : "verify";
        }

        const cantFinal = match?.cantidad_ajustada ?? inv.cantidad;
        rows.push({
          desc_factura:      inv.descripcion,
          cantidad:          inv.cantidad,
          cantidad_ajustada: match?.cantidad_ajustada ?? null,
          nota_cantidad:     match?.nota_cantidad ?? null,
          valor_cop:         inv.valor_unitario,
          valor_usd:         vr_usd,
          nombre_sistema:    match?.nombre ?? null,
          codigo:            match?.codigo ?? null,
          unidad_manejo:     match?.unidad_manejo ?? null,
          unidad_subpartida: match?.unidad_subpartida ?? null,
          peso_kg:           match?.peso_kg ?? null,
          peso_total:        match?.peso_kg ? +(match.peso_kg * cantFinal).toFixed(3) : null,
          status,
        });
      }

      setResults({ rows, tasa: tasaNum, total: rows.length });
      setProgress("");
    } catch (e) {
      setError(e.message || "Error desconocido");
    }
    setLoading(false);
  }, [pdfFile, xlsxFile, tasa]);

  const found      = results?.rows.filter(r => r.status === "found").length    || 0;
  const verify     = results?.rows.filter(r => r.status === "verify").length   || 0;
  const notfound   = results?.rows.filter(r => r.status === "notfound").length || 0;
  const totalPeso  = results?.rows.reduce((s, r) => s + (r.peso_total || 0), 0) || 0;
  const progPct  = progTotal > 0 ? Math.round((progIdx / progTotal) * 100) : 0;

  const COLS = ["#","Desc. Factura","Nombre en Sistema","Codigo","Cant.","Cant. Aj.","UM Apollo","U.Sub.","COP","USD","Peso Unit.","Peso Total","Estado"];

  // ── Shared dark glass style ───────────────────────────────────────────────
  const glassCard = {
  background: "rgba(15,23,42,0.55)",
  backdropFilter: "blur(16px)",
  borderRadius: 24,
  boxShadow: "0 24px 64px rgba(0,0,0,0.4)",
};

  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(160deg,#0f172a 0%,#1e3a5f 55%,#0f2744 100%)", padding: "40px 16px", fontFamily: "'Segoe UI',Arial,sans-serif" }}>
      <div style={{ maxWidth: 1280, margin: "0 auto" }}>

        {/* ── Header ── */}
        <div style={{ textAlign: "center", marginBottom: 36 }}>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 12, background: "rgba(255,255,255,0.08)", borderRadius: 20, padding: "10px 28px", marginBottom: 14, backdropFilter: "blur(8px)" }}>
            <span style={{ fontSize: 28 }}>🏗️</span>
            <span style={{ color: "#fff", fontSize: 22, fontWeight: 800, letterSpacing: "-0.5px" }}>{"Yeikel's App - Invoice Matcher"}</span>
            <span style={{ background: "linear-gradient(135deg,#6366f1,#3b82f6)", color: "#fff", fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 999 }}>v2.0</span>
          </div>
          <p style={{ color: "#93c5fd", margin: 0, fontSize: 13 }}>
            Cruce Inteligente de Facturas · TF-IDF + GPT-4o · Unidades de Manejo · Pesos Estimados
          </p>
        </div>

        {/* ── Config Card ── */}
        <div style={{ ...glassCard, padding: 32, marginBottom: 28 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 24 }}>
            <div style={{ width: 38, height: 38, borderRadius: 11, background: "linear-gradient(135deg,#6366f1,#3b82f6)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 19 }}>⚙️</div>
            <div>
              <h2 style={{ margin: 0, fontSize: 17, fontWeight: 800, color: "#f1f5f9" }}>Configuracion</h2>
              <p style={{ margin: 0, fontSize: 11, color: "rgba(148,163,184,0.8)" }}>Carga la factura PDF y el inventario Excel</p>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 22 }}>
            <DropZone label="Arrastra o clic — Factura PDF" accept=".pdf" icon="📄" file={pdfFile} onFile={setPdfFile} />
            <DropZone label="Arrastra o clic — Inventario Excel (.xlsx)" accept=".xlsx,.xls" icon="📊" file={xlsxFile} onFile={setXlsxFile} />
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 20, flexWrap: "wrap" }}>
            <label style={{ fontSize: 13, fontWeight: 700, color: "#cbd5e1", whiteSpace: "nowrap" }}>💱 Tasa COP → USD</label>
            <input
              type="number" value={tasa} onChange={(e) => setTasa(e.target.value)} placeholder="Ej: 4200"
              style={{ border: "1.5px solid rgba(255,255,255,0.15)", borderRadius: 10, padding: "9px 14px", fontSize: 14, width: 150, outline: "none", background: "rgba(255,255,255,0.08)", color: "#f1f5f9", fontWeight: 600 }}
            />
            {tasa && Number(tasa) > 0 && (
              <span style={{ fontSize: 12, color: "#818cf8", fontWeight: 700, background: "rgba(99,102,241,0.2)", padding: "5px 14px", borderRadius: 999, border: "1px solid rgba(99,102,241,0.3)" }}>
                $1 USD = ${Number(tasa).toLocaleString("es-CO")} COP
              </span>
            )}
          </div>

          <div style={{ background: "rgba(99,102,241,0.15)", border: "1px solid rgba(99,102,241,0.3)", borderRadius: 12, padding: "11px 16px", marginBottom: 22, fontSize: 12, color: "#a5b4fc", display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 18 }}>🧠</span>
            <span>
              <strong style={{ color: "#c7d2fe" }}>Motor IA:</strong> TF-IDF filtra top 5 candidatos del inventario · GPT-4o elige el match correcto,
              valida cantidades con <strong style={{ color: "#c7d2fe" }}>Unidad de Manejo</strong> y estima <strong style={{ color: "#c7d2fe" }}>pesos unitarios</strong>
            </span>
          </div>

          <button
            onClick={run} disabled={!canRun}
            style={{
              width: "100%", padding: "15px 0", borderRadius: 14, border: "none",
              fontWeight: 800, fontSize: 15, cursor: canRun ? "pointer" : "not-allowed",
              background: canRun ? "linear-gradient(135deg,#6366f1,#3b82f6)" : "rgba(255,255,255,0.08)",
              color: canRun ? "#fff" : "rgba(255,255,255,0.3)",
              transition: "all 0.2s",
              boxShadow: canRun ? "0 6px 20px rgba(99,102,241,0.4)" : "none",
            }}
          >
            {loading ? "Procesando..." : "🚀 Procesar Factura"}
          </button>

          {loading && (
            <div style={{ marginTop: 18 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ width: 15, height: 15, border: "2.5px solid #6366f1", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
                  <span style={{ fontSize: 13, color: "#a5b4fc", fontWeight: 600 }}>{progress}</span>
                </div>
                {progTotal > 0 && <span style={{ fontSize: 12, color: "#818cf8", fontWeight: 800 }}>{progPct}%</span>}
              </div>
              {progTotal > 0 && (
                <div style={{ background: "rgba(99,102,241,0.2)", borderRadius: 999, height: 7, overflow: "hidden" }}>
                  <div style={{ height: "100%", background: "linear-gradient(90deg,#6366f1,#3b82f6)", borderRadius: 999, width: `${progPct}%`, transition: "width 0.35s ease" }} />
                </div>
              )}
            </div>
          )}

          {error && (
            <div style={{ background: "rgba(239,68,68,0.15)", border: "1px solid rgba(239,68,68,0.3)", color: "#fca5a5", borderRadius: 12, padding: "13px 16px", marginTop: 16, fontSize: 13, display: "flex", gap: 10, alignItems: "flex-start" }}>
              <span style={{ fontSize: 16 }}>❌</span><span>{error}</span>
            </div>
          )}
        </div>

        {/* ── Results ── */}
        {results && (
          <div style={{ ...glassCard, padding: 32 }}>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 16, marginBottom: 24 }}>
              <div>
                <h2 style={{ margin: "0 0 4px", fontSize: 18, fontWeight: 800, color: "#f1f5f9" }}>Resultados del Cruce</h2>
                <p style={{ margin: 0, fontSize: 12, color: "rgba(148,163,184,0.8)" }}>{results.total} items procesados · Tasa: ${results.tasa.toLocaleString("es-CO")} COP/USD</p>
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <StatCard icon="✅" label="Encontrados"   value={found}    color="#15803d" bg="#dcfce7" border="#86efac" />
                <StatCard icon="⚠️" label="Verificar"     value={verify}   color="#a16207" bg="#fef9c3" border="#fde047" />
                <StatCard icon="❌" label="No encontrado" value={notfound} color="#b91c1c" bg="#fee2e2" border="#fca5a5" />
              </div>
              <button
                onClick={() => exportXLSX(results.rows)}
                style={{ padding: "11px 22px", background: "linear-gradient(135deg,#16a34a,#15803d)", color: "#fff", border: "none", borderRadius: 12, fontSize: 13, fontWeight: 700, cursor: "pointer", boxShadow: "0 4px 14px rgba(22,163,74,0.4)", whiteSpace: "nowrap" }}
              >
                ⬇️ Descargar Excel
              </button>
            </div>

            <div style={{ background: "rgba(99,102,241,0.12)", border: "1.5px solid rgba(99,102,241,0.3)", borderRadius: 14, padding: "14px 24px", marginBottom: 20, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: "#a5b4fc" }}>⚖️ Peso Total de Factura</span>
              <span style={{ fontSize: 22, fontWeight: 800, color: "#c7d2fe", letterSpacing: "-0.5px" }}>
                {fmtNum(totalPeso, 3)} <span style={{ fontSize: 13, fontWeight: 500, color: "#818cf8" }}>kg</span>
              </span>
            </div>

            <div style={{ overflowX: "auto", borderRadius: 16, border: "1px solid rgba(255,255,255,0.1)" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ background: "rgba(15,23,42,0.8)" }}>
                    {COLS.map((h) => (
                      <th key={h} style={{ padding: "11px 12px", textAlign: "left", fontWeight: 700, whiteSpace: "nowrap", color: "#94a3b8", fontSize: 11, letterSpacing: "0.4px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {results.rows.map((r, i) => (
                    <tr key={i} style={{ background: i % 2 === 0 ? "rgba(255,255,255,0.03)" : "rgba(255,255,255,0.06)", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                      <td style={{ padding: "9px 12px", color: "rgba(148,163,184,0.6)", fontFamily: "monospace", fontSize: 11 }}>{i + 1}</td>
                      <td style={{ padding: "9px 12px", color: "#cbd5e1", maxWidth: 200, fontSize: 12 }}>{r.desc_factura}</td>
                      <td style={{ padding: "9px 12px", fontWeight: 700, color: r.nombre_sistema ? "#f1f5f9" : "#f87171", fontStyle: r.nombre_sistema ? "normal" : "italic", maxWidth: 200 }}>
                        {r.nombre_sistema || "NO ENCONTRADO"}
                      </td>
                      <td style={{ padding: "9px 12px", fontFamily: "monospace", color: "#818cf8", fontWeight: 700, fontSize: 11 }}>{r.codigo || "—"}</td>
                      <td style={{ padding: "9px 12px", textAlign: "center", color: "#e2e8f0", fontWeight: 600 }}>{r.cantidad}</td>
                      <td style={{ padding: "9px 12px", textAlign: "center" }}>
                        {r.cantidad_ajustada != null
                          ? <span style={{ color: "#fbbf24", fontWeight: 800, background: "rgba(251,191,36,0.15)", padding: "2px 8px", borderRadius: 8 }} title={r.nota_cantidad || ""}>{r.cantidad_ajustada} {r.nota_cantidad ? "ℹ️" : ""}</span>
                          : <span style={{ color: "rgba(148,163,184,0.4)" }}>—</span>}
                      </td>
                      <td style={{ padding: "9px 12px", color: "#38bdf8", fontWeight: 700, whiteSpace: "nowrap", fontSize: 11 }}>{r.unidad_manejo || "—"}</td>
                      <td style={{ padding: "9px 12px", color: "#7dd3fc", whiteSpace: "nowrap", fontSize: 11 }}>{r.unidad_subpartida || "—"}</td>
                      <td style={{ padding: "9px 12px", textAlign: "right", color: "#86efac", fontSize: 11 }}>{r.valor_cop != null ? fmtNum(r.valor_cop, 0) : "—"}</td>
                      <td style={{ padding: "9px 12px", textAlign: "right", fontWeight: 800, color: "#4ade80", fontSize: 12 }}>
                        {r.valor_usd != null ? fmtNum(r.valor_usd) : "—"}
                      </td>
                      <td style={{ padding: "9px 12px", textAlign: "right", color: "#c4b5fd", fontSize: 11 }}>
                        {r.peso_kg != null ? <span style={{ background: "rgba(139,92,246,0.15)", padding: "2px 7px", borderRadius: 8 }}>{fmtNum(r.peso_kg, 3)} kg</span> : "—"}
                      </td>
                      <td style={{ padding: "9px 12px", textAlign: "right", fontWeight: 700, fontSize: 12 }}>
                        {r.peso_total != null ? <span style={{ background: "rgba(99,102,241,0.2)", color: "#a5b4fc", padding: "2px 7px", borderRadius: 8 }}>{fmtNum(r.peso_total, 3)} kg</span> : "—"}
                      </td>
                      <td style={{ padding: "9px 12px" }}><StatusBadge status={r.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <p style={{ textAlign: "center", color: "rgba(148,163,184,0.4)", fontSize: 11, marginTop: 28 }}>
          {"Yeikel's App © 2026 · Hecho con ❤️ por Yeikel"}
        </p>
      </div>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        tbody tr:hover td { background: rgba(99,102,241,0.08) !important; transition: background 0.15s; }
        input::placeholder { color: rgba(148,163,184,0.5); }
        input:focus { border-color: rgba(99,102,241,0.6) !important; box-shadow: 0 0 0 3px rgba(99,102,241,0.15); }
      `}</style>
    </div>
  );
}
