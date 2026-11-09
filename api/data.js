const A = "https://api.airtable.com/v0";

module.exports = async (req, res) => {
  const token = process.env.AIRTABLE_TOKEN;
  const base = process.env.AIRTABLE_BASE_ID;
  const table = process.env.AIRTABLE_TABLE || "Einträge";
  const table2 = process.env.AIRTABLE_TABLE2 || "Rückmeldungen";
  if (!token || !base) return res.status(500).json({ error: "Server nicht konfiguriert (ENV fehlt)" });

  let op = req.query && req.query.op;
  if (!op) { try { op = new URL(req.url, "http://x").searchParams.get("op"); } catch (_) {} }

  const url = `${A}/${base}/${encodeURIComponent(table)}`;
  const url2 = `${A}/${base}/${encodeURIComponent(table2)}`;
  const H = { Authorization: `Bearer ${token}` };
  const HJ = { ...H, "Content-Type": "application/json" };

  async function listAll(u) {
    let recs = [], offset;
    do {
      const x = new URL(u);
      x.searchParams.set("pageSize", "100");
      if (offset) x.searchParams.set("offset", offset);
      const r = await fetch(x, { headers: H });
      const d = await r.json();
      if (!r.ok) throw { status: r.status, msg: (d.error && d.error.message) || "Airtable-Fehler" };
      recs = recs.concat(d.records || []);
      offset = d.offset;
    } while (offset);
    return recs;
  }

  // Schreibsperre für Erfassen + Fazit (Tabelle Einträge).
  // Standard: gesperrt. Wieder öffnen: in Vercel READ_ONLY=false setzen und neu deployen.
  // Ausnahme: Gruppen in OPEN_CYCLES (Standard «Logopädie») dürfen weiter Rohdaten erfassen/löschen.
  const LOCKED = String(process.env.READ_ONLY || "true").toLowerCase() !== "false";
  const OPEN_CYCLES = String(process.env.OPEN_CYCLES || "Logopädie").split(",").map(s => s.trim()).filter(Boolean);
  const mayWrite = (zyklus, ebene) => !LOCKED || (OPEN_CYCLES.includes(zyklus) && (ebene || "Rohdaten") === "Rohdaten");
  const LOCK_MSG = "Erfassen und Fazit sind während der Vernehmlassung schreibgeschützt.";

  try {
    if (op === "config") {
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ locked: LOCKED, openCycles: OPEN_CYCLES });
    }

    // ---- Konsens / Erfassung (Tabelle Einträge) ----
    if (op === "results") {
      const recs = await listAll(url);
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ records: recs.map(x => ({ id: x.id, ...x.fields })) });
    }

    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

    if (op === "submit") {
      const { zyklus, feld, fragetyp, aussage, indikator, quelle, ebene, oecd } = body || {};
      if (!aussage || !feld) return res.status(400).json({ error: "aussage und feld erforderlich" });
      if (!mayWrite(zyklus, ebene)) return res.status(403).json({ error: LOCK_MSG });
      const fields = { Aussage: aussage, Feld: feld, Ebene: ebene || "Rohdaten" };
      if (zyklus) fields.Zyklus = zyklus;
      if (fragetyp) fields.Fragetyp = fragetyp;
      if (indikator) fields.Indikator = indikator;
      if (quelle) fields.Quelle = quelle;
      if (oecd) fields.OECD = oecd;
      const r = await fetch(url, { method: "POST", headers: HJ, body: JSON.stringify({ fields, typecast: true }) });
      const d = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: (d.error && d.error.message) || "Airtable-Fehler" });
      return res.status(200).json({ id: d.id });
    }

    if (op === "delete") {
      const id = body && body.id;
      if (!id) return res.status(400).json({ error: "id erforderlich" });
      if (LOCKED) {
        // Nur löschen, wenn der Eintrag zu einer offenen Gruppe gehört (Zyklus + Ebene serverseitig geprüft)
        const gr = await fetch(`${url}/${encodeURIComponent(id)}`, { headers: H });
        const gd = await gr.json();
        if (!gr.ok) return res.status(gr.status).json({ error: (gd.error && gd.error.message) || "Airtable-Fehler" });
        const f = gd.fields || {};
        if (!mayWrite(f.Zyklus, f.Ebene)) return res.status(403).json({ error: LOCK_MSG });
      }
      const r = await fetch(`${url}/${encodeURIComponent(id)}`, { method: "DELETE", headers: H });
      const d = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: (d.error && d.error.message) || "Airtable-Fehler" });
      return res.status(200).json({ deleted: id });
    }

    // ---- Vernehmlassung (Tabelle Rückmeldungen) ----
    if (op === "feedback-results") {
      const recs = await listAll(url2);
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ records: recs.map(x => ({ id: x.id, ...x.fields })) });
    }

    if (op === "feedback") {
      const { art, ref, feld, fragetyp, satz, schulhaus, zyklus, zustimmung, alternativtext } = body || {};
      if (!schulhaus || !zyklus) return res.status(400).json({ error: "schulhaus und zyklus erforderlich" });

      if (art === "bedarf") {
        const txt = (alternativtext || "").trim();
        if (!txt) return res.status(400).json({ error: "bedarf-text erforderlich" });
        const fields = { Feld: "Bedarf Team", Schulhaus: schulhaus, Zyklus: zyklus, Alternativtext: txt };
        const r = await fetch(url2, { method: "POST", headers: HJ, body: JSON.stringify({ fields, typecast: true }) });
        const d = await r.json();
        if (!r.ok) return res.status(r.status).json({ error: (d.error && d.error.message) || "Airtable-Fehler" });
        return res.status(200).json({ id: d.id });
      }

      // Votum zu einem Konsens-Satz: Upsert nach Ref + Schulhaus + Zyklus
      if (!ref || !zustimmung) return res.status(400).json({ error: "ref und zustimmung erforderlich" });
      const fields = { Satz: satz || "", Ref: ref, Schulhaus: schulhaus, Zyklus: zyklus, Zustimmung: zustimmung, Alternativtext: (alternativtext || "") };
      if (feld) fields.Feld = feld;
      if (fragetyp) fields.Fragetyp = fragetyp;

      const esc = s => String(s).replace(/"/g, '\\"');
      const formula = `AND({Ref}="${esc(ref)}",{Schulhaus}="${esc(schulhaus)}",{Zyklus}="${esc(zyklus)}")`;
      const q = new URL(url2);
      q.searchParams.set("filterByFormula", formula);
      q.searchParams.set("maxRecords", "1");
      const fr = await fetch(q, { headers: H });
      const fd = await fr.json();
      if (!fr.ok) return res.status(fr.status).json({ error: (fd.error && fd.error.message) || "Airtable-Fehler" });

      if (fd.records && fd.records.length) {
        const id = fd.records[0].id;
        const r = await fetch(`${url2}/${id}`, { method: "PATCH", headers: HJ, body: JSON.stringify({ fields, typecast: true }) });
        const d = await r.json();
        if (!r.ok) return res.status(r.status).json({ error: (d.error && d.error.message) || "Airtable-Fehler" });
        return res.status(200).json({ id: d.id, updated: true });
      } else {
        const r = await fetch(url2, { method: "POST", headers: HJ, body: JSON.stringify({ fields, typecast: true }) });
        const d = await r.json();
        if (!r.ok) return res.status(r.status).json({ error: (d.error && d.error.message) || "Airtable-Fehler" });
        return res.status(200).json({ id: d.id, created: true });
      }
    }

    if (op === "feedback-delete") {
      const id = body && body.id;
      if (!id) return res.status(400).json({ error: "id erforderlich" });
      const r = await fetch(`${url2}/${id}`, { method: "DELETE", headers: H });
      const d = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: (d.error && d.error.message) || "Airtable-Fehler" });
      return res.status(200).json({ deleted: id });
    }

    return res.status(400).json({ error: "unbekannte op" });
  } catch (e) {
    if (e && e.status) return res.status(e.status).json({ error: e.msg });
    return res.status(500).json({ error: String(e) });
  }
};
