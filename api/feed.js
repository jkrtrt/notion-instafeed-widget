// api/feed.js (Node Serverless Function)
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

async function queryDatabase(database_id, comptes) {
  const headers = {
    "Authorization": `Bearer ${process.env.NOTION_TOKEN}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json"
  };
  const sorts = [{ property: "Date de publication", direction: "descending" }];
  let filter;
  if (comptes && comptes.length) {
    const ors = comptes.map(name => ({ property: "Comptes", multi_select: { contains: name } }));
    ors.push({ property: "Comptes", select: { equals: comptes[0] } });
    filter = { or: ors };
  }
  let hasMore = true, start_cursor, pages = [];
  while (hasMore && pages.length < 500) {
    const body = JSON.stringify({ filter, sorts, page_size: 100, start_cursor });
    const res = await fetch(`${NOTION_API}/databases/${database_id}/query`, { method: "POST", headers, body });
    if (!res.ok) throw new Error(await res.text() || `Notion query failed (${res.status})`);
    const data = await res.json();
    pages.push(...data.results); hasMore = data.has_more; start_cursor = data.next_cursor || undefined;
  }
  return pages;
}

function getProp(page, name) { return page.properties?.[name]; }
function fmtMedia(file) {
  if (!file) return null;
  const url = file.file?.url || file.external?.url;
  const name = file.name || "";
  const lower = (file.type || name || "").toLowerCase();
  const isVideo = /video|\.mp4|\.mov|\.webm|\.m4v/.test(lower);
  const isImage = /image|\.jpg|\.jpeg|\.png|\.webp|\.gif/.test(lower);
  return { url, type: isVideo ? "video" : (isImage ? "image" : "image"), name };
}
function plainText(rich) { return (rich || []).map(x => x.plain_text || "").join(""); }
function normalize(page) {
  const id = page.id;
  const dateProp = getProp(page, "Date de publication");
  const comptesProp = getProp(page, "Comptes");
  const visuelsProp = getProp(page, "Visuels");
  const captionProp = getProp(page, "Caption") || getProp(page, "Légende");
  const lienProp = getProp(page, "Lien") || getProp(page, "URL");
  const dateISO = dateProp?.date?.start || null;
  let comptes = [];
  if (comptesProp?.type === "multi_select") comptes = comptesProp.multi_select.map(s => s.name);
  else if (comptesProp?.type === "select" && comptesProp.select) comptes = [comptesProp.select.name];
  else if (comptesProp?.type === "rich_text") comptes = [plainText(comptesProp.rich_text)];
  const files = (visuelsProp?.files || []).map(fmtMedia).filter(Boolean);
  const caption = captionProp?.type === "rich_text" ? plainText(captionProp.rich_text) : "";
  const link = lienProp?.url || null;
  return { id, date: dateISO, comptes, files, caption, link };
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    const database_id = (req.query?.database_id || req.query?.db || "").toString();
    const comptesRaw = (req.query?.comptes || "").toString();
    const comptes = comptesRaw ? comptesRaw.split(",").map(s => s.trim()).filter(Boolean) : [];
    if (!database_id) return res.status(400).json({ error: "Missing database_id" });

    const pages = await queryDatabase(database_id, comptes);
    const items = pages.map(normalize).filter(x => x.files && x.files.length)
      .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    const comptesSet = Array.from(new Set(items.flatMap(i => i.comptes || []))).sort();

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ ok: true, total: items.length, comptes: comptesSet, items });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e?.message || "Server error" });
  }
}
