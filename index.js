// index.js – Power Monitor Backend (Mode A) [Render-safe]
// ------------------------------------------------------
// - Polls Tuya plug continuously and writes readings to Firebase RTDB
// - Enforces schedule from /schedule
// - Listens to /control/command for manual ON/OFF (from Flutter app)
// - Uses FIREBASE_SERVICE_ACCOUNT_JSON env var on Render (no local JSON file)

const axios = require("axios");
const crypto = require("crypto");
const admin = require("firebase-admin");

// ======================================================
// FIREBASE INIT (Render-safe)
// ======================================================
// On Render, set an env var: FIREBASE_SERVICE_ACCOUNT_JSON
// Its value = the FULL JSON of your Firebase service account key.

function initFirebase() {
  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const databaseURL = process.env.FIREBASE_DATABASE_URL;

  if (!json) throw new Error("Missing env FIREBASE_SERVICE_ACCOUNT_JSON");
  if (!databaseURL) throw new Error("Missing env FIREBASE_DATABASE_URL");

  const serviceAccount = JSON.parse(json);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL,
  });

  console.log("✅ Firebase initialized");
}

initFirebase();
const db = admin.database();

// ======================================================
// TUYA CONFIG (put these in Render env too if you want)
// ======================================================

const clientId = process.env.TUYA_CLIENT_ID || "5urvraenffcq579wss7f";
const clientSecret =
  process.env.TUYA_CLIENT_SECRET || "168f6566bcc74c8f9f050b579e33c13d";
const deviceId = process.env.TUYA_DEVICE_ID || "eba98daf700c720018hrla";
const baseUrl = process.env.TUYA_BASE_URL || "https://openapi.tuyaus.com";

const LOAD_THRESHOLD_W = 5;
let accessToken = null;

// ======================================================
// TUYA SIGN HELPERS
// ======================================================

function calculateSign(content, secret) {
  return crypto.createHmac("sha256", secret).update(content, "utf8").digest("hex").toUpperCase();
}

async function refreshAccessToken() {
  const timestamp = Date.now();
  const emptyBodyHash =
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

  const stringToSign =
    clientId +
    timestamp +
    "GET\n" +
    emptyBodyHash +
    "\n\n" +
    "/v1.0/token?grant_type=1";

  const sign = calculateSign(stringToSign, clientSecret);

  const res = await axios.get(`${baseUrl}/v1.0/token?grant_type=1`, {
    headers: {
      client_id: clientId,
      sign,
      t: String(timestamp),
      sign_method: "HMAC-SHA256",
    },
    timeout: 15000,
  });

  if (!res.data.success) {
    throw new Error(`Token error: ${res.data.msg || "unknown"}`);
  }

  accessToken = res.data.result.access_token;
  console.log("✅ Got Tuya access token");
  return accessToken;
}

async function ensureToken() {
  if (!accessToken) await refreshAccessToken();
}

// ======================================================
// TUYA API
// ======================================================

async function getDeviceStatus() {
  await ensureToken();

  const timestamp = Date.now();
  const path = `/v1.0/devices/${deviceId}/status`;
  const emptyBodyHash =
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

  const stringToSign =
    clientId +
    accessToken +
    timestamp +
    "GET\n" +
    emptyBodyHash +
    "\n\n" +
    path;

  const sign = calculateSign(stringToSign, clientSecret);

  const res = await axios.get(`${baseUrl}${path}`, {
    headers: {
      client_id: clientId,
      access_token: accessToken,
      sign,
      t: String(timestamp),
      sign_method: "HMAC-SHA256",
    },
    timeout: 15000,
  });

  if (!res.data.success) {
    // token expired -> refresh once
    if (res.data.code === "1010" || res.data.code === 1010) {
      accessToken = null;
      await ensureToken();
      return await getDeviceStatus();
    }
    throw new Error(res.data.msg || "Failed to get status");
  }

  const list = res.data.result || [];
  let voltage = 0;
  let current = 0;
  let power = 0;
  let isOn = false;

  for (const item of list) {
    const code = item.code;
    const value = item.value;
    if (code === "cur_voltage") voltage = Number(value) / 10.0;
    if (code === "cur_current") current = Number(value) / 1000.0;
    if (code === "cur_power") power = Number(value) / 10.0;
    if (code === "switch_1") isOn = !!value;
  }

  const loadOn = isOn && power >= LOAD_THRESHOLD_W;
  return { voltage, current, power, isOn, loadOn };
}

async function sendToggleCommand(turnOn, source = "manual") {
  await ensureToken();

  const timestamp = Date.now();
  const path = `/v1.0/devices/${deviceId}/commands`;

  const body = { commands: [{ code: "switch_1", value: !!turnOn }] };
  const jsonBody = JSON.stringify(body);

  const contentHash = crypto.createHash("sha256").update(jsonBody, "utf8").digest("hex");

  const stringToSign =
    clientId +
    accessToken +
    timestamp +
    "POST\n" +
    contentHash +
    "\n\n" +
    path;

  const sign = calculateSign(stringToSign, clientSecret);

  const res = await axios.post(`${baseUrl}${path}`, body, {
    headers: {
      client_id: clientId,
      access_token: accessToken,
      sign,
      t: String(timestamp),
      sign_method: "HMAC-SHA256",
      "Content-Type": "application/json",
    },
    timeout: 15000,
  });

  if (!res.data.success) {
    throw new Error(res.data.msg || "Toggle failed");
  }

  console.log(`⚡ switch_1 => ${turnOn ? "ON" : "OFF"} by ${source}`);

  await db.ref("control/lastAction").set({
    turnOn: !!turnOn,
    source,
    at: admin.database.ServerValue.TIMESTAMP,
  });
}

// ======================================================
// FIREBASE NODES
// ======================================================

const readingsRef = db.ref("readings");
const statusRef = db.ref("status/current");
const scheduleRef = db.ref("schedule");
const commandRef = db.ref("control/command");

let lastKnownRelay = false;
let scheduleConfig = null;

// Watch schedule config
scheduleRef.on(
  "value",
  (snap) => {
    scheduleConfig = snap.val();
    console.log("🗓️ Schedule updated:", scheduleConfig);
  },
  (err) => console.error("Schedule watch error", err)
);

// Watch manual commands
commandRef.on(
  "value",
  async (snap) => {
    const cmd = snap.val();
    if (!cmd) return;

    try {
      const desired = !!cmd.turnOn;
      if (desired === lastKnownRelay) return;

      await sendToggleCommand(desired, "app");
      lastKnownRelay = desired;

      // IMPORTANT: clear command so it doesn't re-trigger on restart
      await commandRef.set(null);
    } catch (err) {
      console.error("Error handling manual command:", err.message || err);
    }
  },
  (err) => console.error("Command watch error", err)
);

// ======================================================
// POLLING (full time monitoring)
// ======================================================

async function pollStatusAndSave() {
  try {
    const data = await getDeviceStatus();
    lastKnownRelay = data.isOn;

    const reading = {
      voltage: data.voltage,
      current: data.current,
      power: data.power,
      is_on: data.isOn,
      load_on: data.loadOn,
      timestamp: admin.database.ServerValue.TIMESTAMP,
    };

    await readingsRef.push(reading);

    await statusRef.set({
      ...reading,
      deviceOnline: true,
      updatedAt: admin.database.ServerValue.TIMESTAMP,
    });

    console.log(
      `📥 V=${data.voltage.toFixed(1)}V I=${data.current.toFixed(3)}A P=${data.power.toFixed(1)}W load_on=${data.loadOn}`
    );
  } catch (err) {
    console.error("pollStatus error:", err.message || err);
    await statusRef.update({
      deviceOnline: false,
      lastError: String(err.message || err),
      errorAt: admin.database.ServerValue.TIMESTAMP,
    });
  }
}

// ======================================================
// SCHEDULE
// ======================================================

function isWithinSchedule(now, cfg) {
  if (!cfg || !cfg.isEnabled) return false;

  const days = Array.isArray(cfg.days) ? cfg.days : [];
  const todayIndex = now.getDay(); // 0=Sun..6=Sat
  if (!days[todayIndex]) return false;

  const start = typeof cfg.start === "string" ? cfg.start : "08:00";
  const end = typeof cfg.end === "string" ? cfg.end : "21:00";

  const [sh, sm] = start.split(":").map((x) => parseInt(x, 10));
  const [eh, em] = end.split(":").map((x) => parseInt(x, 10));

  const startMinutes = sh * 60 + sm;
  const endMinutes = eh * 60 + em;
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  if (startMinutes <= endMinutes) {
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  } else {
    return nowMinutes >= startMinutes || nowMinutes < endMinutes;
  }
}

async function enforceSchedule() {
  if (!scheduleConfig || !scheduleConfig.isEnabled) return;

  try {
    const now = new Date();
    const shouldBeOn = isWithinSchedule(now, scheduleConfig);

    if (shouldBeOn === lastKnownRelay) return;

    await sendToggleCommand(shouldBeOn, "schedule");
    lastKnownRelay = shouldBeOn;

    console.log(`🕒 Schedule enforced: ${shouldBeOn ? "ON" : "OFF"}`);
  } catch (err) {
    console.error("enforceSchedule error:", err.message || err);
  }
}

// ======================================================
// MAIN LOOP
// ======================================================

console.log("🚀 Power monitor backend starting (Mode A)...");

// Poll Tuya every 60 seconds
setInterval(pollStatusAndSave, 60 * 1000);

// Enforce schedule every 30 seconds
setInterval(enforceSchedule, 30 * 1000);

// Start immediately once
pollStatusAndSave().catch(() => {});
