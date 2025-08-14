// api/feed.js (Node Serverless Function) — v2 ajoute `format`
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

  let filter = undefined;
  if (comptes && comptes.length) {
    const ors = comptes.map(name => ({
      property: "Comptes",
      multi_select: { contains: name }
    }));
    // fallback si "Comptes" est Select simple
    ors.push({ property: "Comptes", select: { equals: comptes[0] } });
    filter = { or: ors };
  }

  let hasMore = true;
  let start_cursor = undefined;
  const pages = [];

  while (hasMore && pages.length < 500) {
    const body = JSON.stringify({
      filter,
      sorts,
      page_size: 100,
      start_cursor
    });

    const res = await fetch(`${NOTION_API}/databases/${database_id}/query`, {
      method: "POST",
      headers, body
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `Notion query failed (${res.status})`);
    }

    const data = await res.json();
    pages.push(...data.results);
    hasMore = data.has_more;
    start_cursor = data.next_cursor || undefined;
  }

  return pages;
}

function getProp(page, name) {
  return page.properties?.[name];
}

function fmtMedia(file) {
  if (!file) return null;
  const url = file.file?.url || file.external?.url;
  const name = file.name || "";
  const lower = (file.type || name || "").toLowerCase();
  const isVideo = /video|\.mp4|\.mov|\.webm|\.m4v/.test(lower);
  const isImage = /image|\.jpg|\.jpeg|\.png|\.webp|\.gif/.test(lower);
  return { url, type: isVideo ? "video" : (isImage ? "image" : "image"), name };
}

function plainText(rich) {
  return (rich || []).map(x => x.plain_text || "").join("");
}

function normalize(page) {
  const id = page.id;
  const dateProp = getProp(page, "Date de publication");
  const comptesProp = getProp(page, "Comptes");
  const visuelsProp = getProp(page, "Visuels");
  const formatProp = getProp(page, "Format");
  const captionProp = getProp(page, "Caption") || getProp(page, "Légende");
  const lienProp = getProp(page, "Lien") || getProp(page, "URL");

  const dateISO = dateProp?.date?.start || null;

  let comptes = [];
  if (comptesProp?.type === "multi_select") {
    comptes = comptesProp.multi_select.map(s => s.name);
  } else if (comptesProp?.type === "select" && comptesProp.select) {
    comptes = [comptesProp.select.name];
  } else if (comptesProp?.type === "rich_text") {
    comptes = [plainText(comptesProp.rich_text)];
  }

  let format = null;
  if (formatProp?.type === "select" && formatProp.select) {
    format = formatProp.select.name;
  } else if (formatProp?.type === "multi_select") {
    format = formatProp.multi_select[0]?.name || null;
  } else if (formatProp?.type === "rich_text") {
    format = plainText(formatProp.rich_text) || null;
  }

  const files = (visuelsProp?.files || []).map(fmtMedia).filter(Boolean);
  const caption = captionProp?.type === "rich_text" ? plainText(captionProp.rich_text) : "";
  const link = lienProp?.url || null;

  return { id, date: dateISO, comptes, format, files, caption, link };
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const database_id = (req.query?.database_id || req.query?.db || "").toString();
    const comptesRaw = (req.query?.comptes || "").toString();
    const comptes = comptesRaw ? comptesRaw.split(",").map(s => s.trim()).filter(Boolean) : [];

    if (!database_id) {
      return res.status(400).json({ error: "Missing database_id" });
    }

    const pages = await queryDatabase(database_id, comptes);
    const items = pages
      .map(normalize)
      .filter(x => x.files && x.files.length)
      .sort((a, b) => (b.date || "").localeCompare(a.date || ""));

    const comptesSet = Array.from(new Set(items.flatMap(i => i.comptes || []))).sort();
    const formatsSet = Array.from(new Set(items.map(i => i.format).filter(Boolean))).sort();

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      total: items.length,
      comptes: comptesSet,
      formats: formatsSet,
      items
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e?.message || "Server error" });
  }
}
