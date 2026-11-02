const A = "https://api.airtable.com/v0";

module.exports = async (req, res) => {
  const token = process.env.AIRTABLE_TOKEN;
  const base = process.env.AIRTABLE_BASE_ID;
  const table = process.env.AIRTABLE_TABLE || "Einträge";
  if (!token || !base) return res.status(500).json({ error: "Server nicht konfiguriert (ENV fehlt)" });

  let op = req.query && req.query.op;
  if (!op) { try { op = new URL(req.url, "http://x").searchParams.get("op"); } catch (_) {} }

  const url = `${A}/${base}/${encodeURIComponent(table)}`;
  const H = { Authorization: `Bearer ${token}` };

  try {
    if (op === "results") {
      let recs = [], offset;
      do {
        const u = new URL(url);
        u.searchParams.set("pageSize", "100");
        if (offset) u.searchParams.set("offset", offset);
        const r = await fetch(u, { headers: H });
        const d = await r.json();
        if (!r.ok) return res.status(r.status).json({ error: (d.error && d.error.message) || "Airtable-Fehler" });
        recs = recs.concat(d.records || []);
        offset = d.offset;
      } while (offset);
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ records: recs.map(x => ({ id: x.id, ...x.fields })) });
    }

    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

    if (op === "submit") {
      const { zyklus, feld, fragetyp, aussage, indikator, quelle, ebene } = body || {};
      if (!aussage || !feld) return res.status(400).json({ error: "aussage und feld erforderlich" });
      const fields = { Aussage: aussage, Feld: feld, Ebene: ebene || "Rohdaten" };
      if (zyklus) fields.Zyklus = zyklus;
      if (fragetyp) fields.Fragetyp = fragetyp;
      if (indikator) fields.Indikator = indikator;
      if (quelle) fields.Quelle = quelle;
      const r = await fetch(url, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ fields, typecast: true }) });
      const d = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: (d.error && d.error.message) || "Airtable-Fehler" });
      return res.status(200).json({ id: d.id });
    }

    if (op === "delete") {
      const id = body && body.id;
      if (!id) return res.status(400).json({ error: "id erforderlich" });
      const r = await fetch(`${url}/${id}`, { method: "DELETE", headers: H });
      const d = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: (d.error && d.error.message) || "Airtable-Fehler" });
      return res.status(200).json({ deleted: id });
    }

    return res.status(400).json({ error: "unbekannte op" });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
};
