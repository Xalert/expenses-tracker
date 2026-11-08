// Fake claude.ai runtime for the statement-importer harness. Never published.
//
// Installs `window.claude.use(name)` with: an in-memory `db` (persisted to localStorage so a reload keeps the
// memory; "Reset mock memory" clears it), a `user` with a fixed id, `downloads.save` that triggers a normal browser
// download, and `sample` / `sample.json` / `sample.limits` that answer the extraction prompt from
// fixtures/answers/extraction.json (chosen by markers in the prompt, else by "Source file:") and the
// categorisation prompt from a keyword table. Settings (failure mode, delay, read-only db, declined downloads) live
// in localStorage "mock-settings" and are edited by the harness panel.
//
// Query parameters: ?outside=1 → no window.claude at all; ?no=sample,db,user,downloads → those resolve null.
(function () {
  "use strict";
  var params = new URLSearchParams(location.search);
  if (params.get("outside") === "1") return;
  var absent = new Set((params.get("no") || "").split(",").filter(Boolean));
  var UID = "u_harness_1";

  function settings() {
    try { return JSON.parse(localStorage.getItem("mock-settings") || "{}"); } catch (e) { return {}; }
  }
  function saveSettings(s) { try { localStorage.setItem("mock-settings", JSON.stringify(s)); } catch (e) { /* ignore */ } }
  function sleep(ms, signal) {
    return new Promise(function (res, rej) {
      if (signal && signal.aborted) { rej({ code: "cancelled", message: "aborted (mock)" }); return; }
      var t = setTimeout(res, ms);
      if (signal) signal.addEventListener("abort", function () { clearTimeout(t); rej({ code: "cancelled", message: "aborted (mock)" }); }, { once: true });
    });
  }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  window.__mockCalls = [];
  window.__lastDownload = null;

  // --- sample ----------------------------------------------------------------------------------------------------

  var answersPromise = fetch("fixtures/answers/extraction.json", { cache: "no-store" }).then(function (r) { return r.json(); });
  var MARKERS = [
    ["ro-bank.csv", ["Extras de cont;Banca Exemplu"]],
    ["savings.txt", ["Cont de economii"]],
    ["uk-bank.csv", ["Northbank plc"]],
    ["wise.csv", ["CARD-77120"]],
    ["card-statement.pdf", ["EXAMPLE CARD SERVICES", "Period: 01/10/2026"]],
  ];
  function pickExtraction(prompt, answers) {
    var body = prompt.split("Statement text:\n<<<")[1] || "";
    for (var i = 0; i < MARKERS.length; i++) {
      if (MARKERS[i][1].every(function (m) { return body.indexOf(m) >= 0; })) return { name: MARKERS[i][0], answer: answers[MARKERS[i][0]] };
    }
    var m = /^Source file: (.+?)(?: \(part \d+ of \d+\))?$/m.exec(prompt);
    if (m && answers[m[1]]) return { name: m[1], answer: answers[m[1]] };
    return { name: null, answer: { account: { name: null, identifier: null, currency: null, bank: null, periodFrom: null, periodTo: null }, transactions: [] } };
  }
  var KEYWORDS = [
    [/lidl|kaufland|mega image|albert heijn|tesco/, "Groceries", 0.92, "supermarket"],
    [/uber|bolt|\btfl\b|omv/, "Transport", 0.86, "transport or fuel"],
    [/netflix|spotify|github/, "Subscriptions", 0.82, "subscription service"],
    [/digi|enel/, "Bills", 0.88, "utility bill"],
    [/pret a manger/, "Food", 0.75, "food shop"],
    [/acme software/, "Salary", 0.95, "employer payment"],
    [/acme design/, "Extra Income", 0.7, "freelance payment"],
    [/amazon/, "Refund", 0.8, "merchant refund"],
    [/dobanda/, "Interest", 0.62, "bank interest"],
    [/impozit|comision/, "Fees", 0.55, "bank fee or tax"],
    [/emag/, "Shopping", 0.6, "online shop"],
    [/transfer intern/, null, 0.2, "looks like own-account transfer"],
  ];
  function categorise(prompt) {
    var cats = [];
    var catBlock = (prompt.split("Categories (kind: name):\n")[1] || "").split("\n\n")[0];
    catBlock.split("\n").forEach(function (l) { var m = /^(expense|income): (.+)$/.exec(l); if (m) cats.push({ kind: m[1], name: m[2] }); });
    var out = [];
    prompt.split("\n").forEach(function (l) {
      var m = /^(\d+) \| (in|out) \| ([^|]*) \| ([^|]*) \|/.exec(l);
      if (!m) return;
      var kind = m[2] === "out" ? "expense" : "income";
      var text = (m[3] + " " + m[4]).toLowerCase();
      var hit = KEYWORDS.find(function (k) { return k[0].test(text); });
      var cat = hit && hit[1] && cats.find(function (c) { return c.kind === kind && c.name === hit[1]; });
      out.push(cat ? { index: Number(m[1]), category: cat.name, kind: kind, confidence: hit[2], reason: hit[3] }
        : { index: Number(m[1]), category: null, kind: kind, confidence: hit ? hit[2] : 0.3, reason: hit ? hit[3] : "unknown merchant" });
    });
    return { suggestions: out };
  }
  function call(input, opts, asJson) {
    opts = opts || {};
    var prompt = typeof input === "string" ? input : input.map(function (t) { return t.content; }).join("\n\n");
    var kind = /You assign categories/.test(prompt) ? "categorisation" : "extraction";
    var images = opts.images ? (opts.images.length !== undefined ? Array.prototype.slice.call(opts.images) : [opts.images]) : [];
    var bytes = new TextEncoder().encode(prompt).length;
    var record = { kind: kind, bytes: bytes, images: images.length, model: opts.model, modelTier: opts.modelTier, prompt: prompt, at: Date.now() };
    window.__mockCalls.push(record);
    var st = settings();
    var signal = opts.signal;
    return (async function () {
      await Promise.resolve(); // leaves "on the next microtask", like the real runtime
      if (signal && signal.aborted) throw { code: "cancelled", message: "aborted before sending (mock)" };
      if (bytes > 262144) throw { code: "prompt_too_large", message: "over 256 KiB (mock)" };
      var think = Number(st.delay != null ? st.delay : 900);
      if (st.fail && st.fail !== "none" && (st.scope === "any" || !st.scope || st.scope === kind)) {
        var code = st.fail;
        if (st.once) saveSettings(Object.assign({}, st, { fail: "none" }));
        await sleep(think, signal);
        var err = { code: code, message: "simulated by mock-claude.js" };
        if (code === "invalid_json") err.text = '{"transactions": [ {"date": "2026-10-0';
        record.result = code;
        throw err;
      }
      var answer;
      if (kind === "extraction") {
        var pick = pickExtraction(prompt, await answersPromise);
        record.fixture = pick.name;
        answer = pick.answer;
      } else answer = categorise(prompt);
      var text = JSON.stringify(answer, null, 1);
      await sleep(think, signal);
      var pieces = 4, so = "";
      for (var i = 1; i <= pieces; i++) {
        var next = text.slice(0, Math.ceil((text.length * i) / pieces));
        var delta = next.slice(so.length);
        so = next;
        if (opts.onText) try { opts.onText({ text: so, delta: delta }); } catch (e) { console.error(e); }
        if (i < pieces) await sleep(Math.max(60, think / 6), signal);
      }
      record.result = "ok";
      return asJson ? JSON.parse(text) : { text: text, truncated: false, modelTierApplied: "quick" };
    })();
  }
  var sample = function (input, opts) { return call(input, opts, false); };
  sample.json = function (input, opts) { return call(input, opts, true); };
  sample.limits = function () {
    return Promise.resolve({ maxPromptBytes: 262144, modelTiers: ["default", "complex", "quick"],
      images: { maxCount: 5, maxInputBytes: 20 * 1024 * 1024, mediaTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"] } });
  };
  Object.freeze(sample);

  // --- db ----------------------------------------------------------------------------------------------------------

  var DB_KEY = "mock-db";
  var store = (function () { try { return JSON.parse(localStorage.getItem(DB_KEY) || "{}"); } catch (e) { return {}; } })();
  function persist() { try { localStorage.setItem(DB_KEY, JSON.stringify(store)); } catch (e) { /* ignore */ } }
  var listeners = new Set();
  var SEG = /^[A-Za-z0-9_\-.~:@+]+$/;
  function checkPath(path, isDoc) {
    var segs = String(path).split("/");
    segs.forEach(function (s) {
      if (!SEG.test(s) || s === "." || s === ".." || new TextEncoder().encode(s).length > 200) throw new TypeError("Bad path segment: " + s);
    });
    if (segs.length > 16) throw new TypeError("Path too deep");
    if ((segs.length % 2 === 0) !== isDoc) throw new TypeError((isDoc ? "Document" : "Collection") + " path has " + segs.length + " segments: " + path);
  }
  function parentOf(p) { return p.split("/").slice(0, -1).join("/"); }
  function lastOf(p) { return p.split("/").pop(); }
  var META = { fromCache: false, hasPendingWrites: false };
  function docSnap(path) {
    var d = store[path];
    return { id: lastOf(path), exists: !!d, data: function () { return d ? clone(d) : undefined; }, metadata: META };
  }
  function colSnap(path) {
    var docs = Object.keys(store).filter(function (p) { return parentOf(p) === path; }).sort().map(docSnap);
    return { docs: docs, size: docs.length, empty: !docs.length, docChanges: function () { return []; }, metadata: META };
  }
  function notify(path) {
    setTimeout(function () {
      listeners.forEach(function (l) {
        if (l.type === "doc" && l.path === path) l.fn(docSnap(path));
        if (l.type === "col" && parentOf(path) === l.path) l.fn(colSnap(l.path));
      });
    }, 0);
  }
  function guardWrite(path) {
    if (settings().dbReadonly) throw { code: "invalid_argument", message: "write refused (mock read-only)" };
    if (path.indexOf("data/users/" + UID + "/") !== 0) throw { code: "invalid_argument", message: "outside your subtree (mock rules)" };
  }
  window.__mockDbWrites = 0;
  function docRef(path) {
    checkPath(path, true);
    return Object.freeze({
      id: lastOf(path), path: path,
      get: function () { return Promise.resolve(docSnap(path)); },
      set: async function (data) {
        if (!data || typeof data !== "object" || Array.isArray(data)) throw { code: "invalid_argument", message: "body must be an object" };
        guardWrite(path); await sleep(25); window.__mockDbWrites++;
        store[path] = clone(data); persist(); notify(path);
      },
      update: async function (data) {
        guardWrite(path); await sleep(25);
        if (!store[path]) throw { code: "invalid_argument", message: "update of a missing document" };
        window.__mockDbWrites++;
        store[path] = Object.assign(store[path], clone(data)); persist(); notify(path);
      },
      delete: async function () { guardWrite(path); await sleep(25); window.__mockDbWrites++; delete store[path]; persist(); notify(path); },
      onSnapshot: function (next) {
        var l = { type: "doc", path: path, fn: next };
        listeners.add(l);
        setTimeout(function () { if (listeners.has(l)) next(docSnap(path)); }, 150);
        return function () { listeners.delete(l); };
      },
      collection: function (sub) { return colRef(path + "/" + sub); },
    });
  }
  function colRef(path) {
    checkPath(path, false);
    var ref = {
      path: path,
      doc: function (id) { return docRef(path + "/" + (id || Math.random().toString(36).slice(2, 12))); },
      add: function (data) { var d = ref.doc(); return d.set(data).then(function () { return d; }); },
      get: function () { return Promise.resolve(colSnap(path)); },
      onSnapshot: function (next) {
        var l = { type: "col", path: path, fn: next };
        listeners.add(l);
        setTimeout(function () { if (listeners.has(l)) next(colSnap(path)); }, 150);
        return function () { listeners.delete(l); };
      },
      where: function () { return ref; }, orderBy: function () { return ref; }, limit: function () { return ref; },
    };
    return Object.freeze(ref);
  }
  var db = Object.freeze({ doc: docRef, collection: colRef });
  window.__mockDb = { dump: function () { return clone(store); }, reset: function () { store = {}; persist(); } };

  // --- user, downloads ---------------------------------------------------------------------------------------------

  var user = Object.freeze({
    id: function () { return Promise.resolve(UID); },
    isOwner: function () { return Promise.resolve(true); },
    canEdit: function () { return Promise.resolve(true); },
    can: function () { return Promise.resolve(null); },
    me: function () { return Promise.resolve({ id: UID, name: "", avatarUrl: "", color: "#888", email: null, isOwner: true, canEdit: true }); },
  });
  var ALLOWED = /\.(gif|png|jpg|jpeg|webp|mp4|webm|mov|txt|json|md|docx|pptx|epub|csv|ttf|html|svg|pdf|xlsx|zip|fig)$/i;
  var downloads = Object.freeze({
    save: async function (req) {
      if (!req || typeof req.filename !== "string" || req.data == null || req.data === "") throw { code: "bad_request", message: "filename and data required" };
      if (!ALLOWED.test(req.filename)) throw { code: "rejected_extension", message: "extension not allowed" };
      await sleep(250);
      if (settings().declineDownloads) throw { code: "declined", message: "viewer declined (mock)" };
      var blob = req.data instanceof Blob ? req.data : new Blob([req.data]);
      window.__lastDownload = { filename: req.filename, text: typeof req.data === "string" ? req.data : null, size: blob.size };
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = req.filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
      return { status: "saved" };
    },
  });

  var impl = { sample: sample, db: db, user: user, downloads: downloads };
  window.claude = Object.freeze({
    use: function (name) {
      return new Promise(function (res) { setTimeout(function () { res(absent.has(name) ? null : impl[name] || null); }, 300); });
    },
  });
})();
