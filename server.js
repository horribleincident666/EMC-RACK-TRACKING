const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const DB_PATH = path.join(DATA_DIR, "racktrack-db.json");
const AUTH_PATH = path.join(DATA_DIR, "auth.json");
const CREDENTIALS_PATH = path.join(ROOT, "server-credentials.txt");

const PRODUCTS = [
  ["AURABRIDGE XC", "ABG XC"],
  ["AURABRIDGE C", "ABG C"],
  ["BOREMAT C", "BMT C"],
  ["FEBRIBRIDGE", "FBG"],
  ["AURACOAT XC 8", "ACXC 8"],
  ["AURACOAT XC 10", "ACXC 10"],
  ["AURACOAT XC 14", "ACXC 14"],
  ["AURACOAT C", "ACC"],
  ["AURACOAT MC", "ACMC"],
  ["AURACOAT M", "ACM"],
  ["AURACOAT F", "ACF"],
  ["AURACOAT UF", "ACUF"],
  ["AURAFIX UF", "AFUF"]
].map(([name, shortName]) => ({ name, shortName }));

const ROWS = ["A", "B", "C", "D", "E"];
const FLOORS = ["G", "1", "2", "3", "4"];
const POSITIONS = Array.from({ length: 30 }, (_, index) => String(index + 1).padStart(2, "0"));

fs.mkdirSync(DATA_DIR, { recursive: true });
const auth = ensureAuth();
ensureDb();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    serveStatic(req, res, url);
  } catch (error) {
    sendJson(res, 500, { error: "Server error", detail: error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`EMC RackTrack server: http://localhost:${PORT}`);
  console.log(`Edit password: ${auth.initialPasswordNotice}`);
  console.log(`Recovery code: ${auth.recoveryCodeNotice}`);
  console.log(`Credentials file: ${CREDENTIALS_PATH}`);
});

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/state") {
    sendJson(res, 200, publicState());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/recover") {
    const body = await readJson(req);
    const current = readAuth();
    if (!body.recoveryCode || body.recoveryCode !== current.recoveryCode) {
      sendJson(res, 403, { error: "Recovery code is not correct." });
      return;
    }
    if (!body.newPassword || String(body.newPassword).length < 4) {
      sendJson(res, 400, { error: "New password must be at least 4 characters." });
      return;
    }
    current.password = hashPassword(String(body.newPassword), current.salt);
    current.updatedAt = new Date().toISOString();
    writeJson(AUTH_PATH, current);
    appendActivity("Edit password changed using recovery code.");
    sendJson(res, 200, { ok: true, message: "Password changed." });
    return;
  }

  const body = req.method === "POST" || req.method === "DELETE" ? await readJson(req) : {};
  if (!checkPassword(body.password)) {
    sendJson(res, 403, { error: "Edit password is required." });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/pallets") {
    const db = readDb();
    const pallet = makePallet(body.pallet || {});
    if (!pallet.locationId) {
      sendJson(res, 400, { error: "Location is required." });
      return;
    }
    const duplicate = db.pallets.find((entry) => entry.locationId === pallet.locationId && entry.id !== pallet.id);
    if (duplicate) {
      sendJson(res, 409, { error: `${pallet.locationId} already has a pallet.` });
      return;
    }
    const existing = db.pallets.findIndex((entry) => entry.id === pallet.id);
    if (existing >= 0) db.pallets[existing] = pallet;
    else db.pallets.push(pallet);
    db.activity.unshift(activity(`${pallet.shortName} ${displayBatch(pallet)} saved at ${pallet.locationId}.`));
    saveDb(db);
    sendJson(res, 200, publicState());
    return;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/pallets/")) {
    const id = decodeURIComponent(url.pathname.split("/").pop());
    const db = readDb();
    const pallet = db.pallets.find((entry) => entry.id === id);
    if (!pallet) {
      sendJson(res, 404, { error: "Pallet not found." });
      return;
    }
    db.pallets = db.pallets.filter((entry) => entry.id !== id);
    db.activity.unshift(activity(`${pallet.shortName} ${displayBatch(pallet)} deleted from ${pallet.locationId}.`));
    saveDb(db);
    sendJson(res, 200, publicState());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/sample") {
    const db = readDb();
    db.locations = generateLocations();
    db.pallets = samplePallets();
    db.activity.unshift(activity("Sample EMC stock loaded."));
    saveDb(db);
    sendJson(res, 200, publicState());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/reset-layout") {
    const db = readDb();
    db.locations = generateLocations();
    db.activity.unshift(activity("EMC rack locations refreshed from guide."));
    saveDb(db);
    sendJson(res, 200, publicState());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/clear-activity") {
    const db = readDb();
    db.activity = [];
    saveDb(db);
    sendJson(res, 200, publicState());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/import") {
    const imported = body.state || {};
    const db = {
      locations: Array.isArray(imported.locations) && imported.locations.length ? imported.locations : generateLocations(),
      pallets: Array.isArray(imported.pallets) ? imported.pallets.map(makePallet) : [],
      activity: Array.isArray(imported.activity) ? imported.activity : []
    };
    db.activity.unshift(activity("RackTrack data imported."));
    saveDb(db);
    sendJson(res, 200, publicState());
    return;
  }

  sendJson(res, 404, { error: "API route not found." });
}

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": contentType(filePath), "Cache-Control": "no-store" });
    res.end(data);
  });
}

function ensureAuth() {
  if (fs.existsSync(AUTH_PATH)) {
    const existing = readAuth();
    return {
      initialPasswordNotice: "already set",
      recoveryCodeNotice: existing.recoveryCode
    };
  }
  const password = readableSecret("EMC");
  const recoveryCode = readableSecret("REC");
  const salt = crypto.randomBytes(16).toString("hex");
  writeJson(AUTH_PATH, {
    salt,
    password: hashPassword(password, salt),
    recoveryCode,
    createdAt: new Date().toISOString()
  });
  fs.writeFileSync(CREDENTIALS_PATH, [
    "EMC RackTrack server credentials",
    "",
    `Edit password: ${password}`,
    `Recovery code: ${recoveryCode}`,
    "",
    "Share the edit password only with people allowed to change stock.",
    "Keep the recovery code with the admin/manager."
  ].join("\n"));
  return {
    initialPasswordNotice: password,
    recoveryCodeNotice: recoveryCode
  };
}

function ensureDb() {
  if (!fs.existsSync(DB_PATH)) {
    writeJson(DB_PATH, {
      locations: generateLocations(),
      pallets: [],
      activity: [activity("EMC online RackTrack database created.")]
    });
  }
}

function generateLocations() {
  return ROWS.flatMap((row) => FLOORS.flatMap((floor) => POSITIONS.map((position) => ({
    id: `${row}-${floor}-${position}`,
    row,
    floor,
    position,
    code: `${row}-${floor}-${position}`
  }))));
}

function samplePallets() {
  return [
    makePallet({ productName: "AURACOAT C", batch: "B250601", locationId: "A-G-01", packaging: "Paper sack pallet", weightClass: 550, fifoDate: "2026-06-01", notes: "Guide sample." }),
    makePallet({ productName: "AURACOAT M", batch: "B250602", locationId: "C-2-15", packaging: "Jumbo bag", weightClass: 650, fifoDate: "2026-06-02", notes: "Guide sample." }),
    makePallet({ productName: "AURABRIDGE XC", batch: "B250610", locationId: "B-1-08", packaging: "Paper sack pallet", weightClass: 650, fifoDate: "2026-06-10", notes: "" }),
    makePallet({ productName: "AURAFIX UF", batch: "B250611", locationId: "D-G-22", packaging: "Jumbo bag", weightClass: 550, fifoDate: "2026-06-11", notes: "" })
  ];
}

function packagingRule(packaging, weightClass) {
  if (packaging === "Jumbo bag") return { bagWeight: weightClass, bagCount: 1, netKg: weightClass };
  if (Number(weightClass) === 650) return { bagWeight: 15.5, bagCount: 42, netKg: 650 };
  return { bagWeight: 13, bagCount: 42, netKg: 550 };
}

function makePallet(input) {
  const product = PRODUCTS.find((entry) => entry.name === input.productName) || PRODUCTS[0];
  const weightClass = Number(input.weightClass || 550);
  const packaging = input.packaging || "Paper sack pallet";
  const rule = packagingRule(packaging, weightClass);
  return {
    id: input.id || crypto.randomUUID(),
    productName: product.name,
    shortName: product.shortName,
    batch: String(input.batch || "").trim(),
    locationId: String(input.locationId || "").trim(),
    packaging,
    weightClass,
    bagWeight: rule.bagWeight,
    bagCount: rule.bagCount,
    netKg: rule.netKg,
    fifoDate: input.fifoDate || new Date().toISOString().slice(0, 10),
    notes: String(input.notes || "").trim()
  };
}

function publicState() {
  return {
    ...readDb(),
    products: PRODUCTS
  };
}

function appendActivity(message) {
  const db = readDb();
  db.activity.unshift(activity(message));
  saveDb(db);
}

function activity(message) {
  return { id: crypto.randomUUID(), at: new Date().toISOString(), message };
}

function displayBatch(pallet) {
  return pallet.batch ? `batch ${pallet.batch}` : "without batch no.";
}

function readDb() {
  return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
}

function saveDb(db) {
  db.activity = (db.activity || []).slice(0, 200);
  writeJson(DB_PATH, db);
}

function readAuth() {
  return JSON.parse(fs.readFileSync(AUTH_PATH, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function checkPassword(password) {
  const current = readAuth();
  return current.password === hashPassword(String(password || ""), current.salt);
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
}

function readableSecret(prefix) {
  const part = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `${prefix}-${part.slice(0, 4)}-${part.slice(4)}`;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 5_000_000) req.destroy();
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png"
  }[ext] || "application/octet-stream";
}
