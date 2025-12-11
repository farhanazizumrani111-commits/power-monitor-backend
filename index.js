// index.js
// Main backend for Power Monitor
// - Talks to Tuya OpenAPI
// - Logs readings to Firebase Realtime DB
// - Applies schedule from /schedule
// - Exposes REST API for Flutter (status, toggle, stats)

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const admin = require("firebase-admin");

// -----------------------------------------------------------
// 🔧 CONFIG
// -----------------------------------------------------------

// Tuya Developer keys
const TUYA_CLIENT_ID = "5urvraenffcq579wss7f";
const TUYA_CLIENT_SECRET = "168f6566bcc74c8f9f050b579e33c13d";
const TUYA_DEVICE_ID = "eba98daf700c720018hrla";
const TUYA_BASE_URL = "https://openapi.tuyaus.com";

// Same threshold as Flutter
const LOAD_THRESHOLD_W = 5.0;

// Your Firebase project
// Make sure Render has credentials via GOOGLE_APPLICATION_CREDENTIALS
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL:
    "https://power-monitoring-b3f6d-default-rtdb.asia-southeast1.firebasedatabase.app/",
});

const db = admin.database();

// -----------------------------------------------------------
// 🔐 TUYA AUTH + SIGNING
// -----------------------------------------------------------

let accessToken = null;
let accessTokenExpireAt = 0; // ms timestamp

const EMPTY_BODY_HASH =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function sha256Hex(str) {
  return crypto.createHash("sha256").update(str, "utf8").digest("hex");
}

function hmacSha256Upper(content, secret) {
  return crypto
    .createHmac("sha256", secret)
    .update(content, "utf8")
    .digest("hex")
    .toUpperCase();
}

async function ensureAccessToken() {
  const now = Date.now();
  if (accessToken && now < accessTokenExpireAt - 60_000) {
    return accessToken;
  }

  const t = Date.now();
  const path = "/v1.0/token?grant_type=1";

  const signStr =
    TUYA_CLIENT_ID +
    t +
    "GET\n" +
    EMPTY_BODY_HASH +
    "\n\n" +
    path;

  const sign = hmacSha256Upper(signStr, TUYA_CLIENT_SECRET);

  try {
    const res = await axios.get(TUYA_BASE_URL + path, {
      headers: {
        client_id: TUYA_CLIENT_ID,
        sign,
        t: String(t),
        sign_method: "HMAC-SHA256",
      },
    });

    if (res.data && res.data.success) {
      accessToken = res.data.result.access_token;
      const expire = res.data.result.expire_time || 7200; // seconds
      accessTokenExpireAt = now + expire * 1000;
      console.log("✅ Got Tuya access token");
      return accessToken;
    }
    console.error("❌ Token error:", res.data);
    return null;
  } catch (err) {
    console.error("❌ Token exception:", err.message);
    return null;
  }
}

// -----------------------------------------------------------
// 📡 TUYA DEVICE OPERATIONS
// -----------------------------------------------------------

async function getDeviceStatusFromTuya() {
  const token = await ensureAccessToken();
  if (!token) return null;

  const t = Date.now();
  const path = `/v1.0/devices/${TUYA_DEVICE_ID}/status`;

  const signStr =
    TUYA_CLIENT_ID +
    token +
    t +
    "GET\n" +
    EMPTY_BODY_HASH +
    "\n\n" +
    path;

  const sign = hmacSha256Upper(signStr, TUYA_CLIENT_SECRET);

  try {
    const res = await axios.get(TUYA_BASE_URL + path, {
      headers: {
        client_id: TUYA_CLIENT_ID,
        access_token: token,
        sign,
        t: String(t),
        sign_method: "HMAC-SHA256",
      },
    });

    if (!res.data || !res.data.success) {
      console.error("❌ Status error:", res.data);
      return null;
    }

    const statusList = res.data.result || [];
    let voltage = 0;
    let current = 0;
    let power = 0;
    let isOn = false;

    for (const item of statusList) {
      const code = item.code;
      const val = item.value;

      if (code === "cur_voltage") {
        voltage = Number(val) / 10.0;
      }
      if (code === "cur_current") {
        current = Number(val) / 1000.0;
      }
      if (code === "cur_power") {
        power = Number(val) / 10.0;
      }
      if (code === "switch_1") {
        isOn = !!val;
      }
    }

    const loadOn = isOn && power >= LOAD_THRESHOLD_W;
    const now = Date.now();

    return {
      voltage,
      current,
      power,
      is_on: isOn,
      load_on: loadOn,
      timestamp: now,
    };
  } catch (err) {
    console.error("❌ Status exception:", err.message);
    return null;
  }
}

async function sendTuyaCommand(turnOn) {
  const token = await ensureAccessToken();
  if (!token) return false;

  const t = Date.now();
  const path = `/v1.0/devices/${TUYA_DEVICE_ID}/commands`;

  const body = {
    commands: [{ code: "switch_1", value: !!turnOn }],
  };
  const jsonBody = JSON.stringify(body);
  const contentHash = sha256Hex(jsonBody);

  const signStr =
    TUYA_CLIENT_ID +
    token +
    t +
    "POST\n" +
    contentHash +
    "\n\n" +
    path;

  const sign = hmacSha256Upper(signStr, TUYA_CLIENT_SECRET);

  try {
    const res = await axios.post(TUYA_BASE_URL + path, body, {
      headers: {
        client_id: TUYA_CLIENT_ID,
        access_token: token,
        sign,
        t: String(t),
        sign_method: "HMAC-SHA256",
        "Content-Type": "application/json",
      },
    });

    if (!res.data || !res.data.success) {
      console.error("❌ Toggle error:", res.data);
      return false;
    }

    console.log("✅ Tuya command success:", turnOn ? "ON" : "OFF");
    return true;
  } catch (err) {
    console.error("❌ Toggle exception:", err.message);
    return false;
  }
}

async function getTuyaStatistics(type) {
  const token = await ensureAccessToken();
  if (!token) return {};

  const now = new Date();
  const endDate =
    now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, "0") +
    String(now.getDate()).padStart(2, "0");

  const start =
    type === "day"
      ? new Date(now.getTime() - 7 * 24 * 3600 * 1000)
      : now;

  const startDate =
    start.getFullYear().toString() +
    String(start.getMonth() + 1).padStart(2, "0") +
    String(start.getDate()).padStart(2, "0");

  const query = `?code=add_ele&start_date=${startDate}&end_date=${endDate}&type=${type}`;
  const path = `/v1.0/devices/${TUYA_DEVICE_ID}/statistics/datas`;
  const fullPath = path + query;

  const t = Date.now();

  const signStr =
    TUYA_CLIENT_ID +
    token +
    t +
    "GET\n" +
    EMPTY_BODY_HASH +
    "\n\n" +
    fullPath;

  const sign = hmacSha256Upper(signStr, TUYA_CLIENT_SECRET);

  try {
    const res = await axios.get(TUYA_BASE_URL + fullPath, {
      headers: {
        client_id: TUYA_CLIENT_ID,
        access_token: token,
        sign,
        t: String(t),
        sign_method: "HMAC-SHA256",
      },
    });

    if (!res.data || !res.data.success || !res.data.result) {
      console.error("❌ Stats error:", res.data);
      return {};
    }

    const raw = res.data.result.add_ele || {};
    const cleaned = {};
    for (const [k, v] of Object.entries(raw)) {
      cleaned[k] = Number(v) || 0;
    }
    return cleaned;
  } catch (err) {
    console.error("❌ Stats exception:", err.message);
    return {};
  }
}

// -----------------------------------------------------------
// 💾 FIREBASE HELPERS
// -----------------------------------------------------------

async function saveReadingToFirebase(status) {
  try {
    await db.ref("readings").push({
      voltage: status.voltage,
      current: status.current,
      power: status.power,
      is_on: status.is_on,
      load_on: status.load_on,
      timestamp: admin.database.ServerValue.TIMESTAMP,
    });
  } catch (err) {
    console.error("❌ Firebase save error:", err.message);
  }
}

async function getSchedule() {
  try {
    const snap = await db.ref("schedule").get();
    if (!snap.exists()) return null;
    return snap.val();
  } catch (err) {
    console.error("❌ Schedule read error:", err.message);
    return null;
  }
}

// -----------------------------------------------------------
// 🕒 SCHEDULE LOGIC
// -----------------------------------------------------------

function parseTimeStr(str) {
  const [h, m] = (str || "00:00").split(":").map((x) => parseInt(x, 10));
  return { h: h || 0, m: m || 0 };
}

function isWithinSchedule(now, schedule) {
  if (!schedule || !schedule.isEnabled) return false;

  const days = schedule.days || [];
  const dayIndex = now.getDay(); // 0=Sun,1=Mon,...
  if (!days[dayIndex]) return false;

  const start = parseTimeStr(schedule.start || "08:00");
  const end = parseTimeStr(schedule.end || "21:00");

  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = start.h * 60 + start.m;
  const endMinutes = end.h * 60 + end.m;

  // Simple non-overnight schedule
  return currentMinutes >= startMinutes && currentMinutes < endMinutes;
}

async function scheduleAndLoggingLoop() {
  console.log("⏱️ Starting schedule + logging loop (every 60s)");

  setInterval(async () => {
    try {
      const status = await getDeviceStatusFromTuya();
      if (!status) return;

      // Always log reading
      await saveReadingToFirebase(status);

      // Apply schedule
      const schedule = await getSchedule();
      if (!schedule || !schedule.isEnabled) return;

      const now = new Date();
      const shouldBeOn = isWithinSchedule(now, schedule);
      const isOn = status.is_on;

      if (shouldBeOn && !isOn) {
        console.log("📅 Schedule says: ON → turning ON");
        await sendTuyaCommand(true);
      } else if (!shouldBeOn && isOn) {
        console.log("📅 Schedule says: OFF → turning OFF");
        await sendTuyaCommand(false);
      }
    } catch (err) {
      console.error("❌ Loop error:", err.message);
    }
  }, 60_000);
}

// -----------------------------------------------------------
// 🌐 EXPRESS API
// -----------------------------------------------------------

const app = express();
app.use(express.json());

// Health check
app.get("/", (req, res) => {
  res.send("Power Monitor backend is running");
});

// Latest live status (Flutter uses this)
app.get("/api/status", async (req, res) => {
  const status = await getDeviceStatusFromTuya();
  if (!status) {
    return res.status(500).json({ success: false, message: "Unable to fetch status" });
  }
  res.json({ success: true, result: status });
});

// Toggle ON/OFF from Flutter
app.post("/api/toggle", async (req, res) => {
  const { on } = req.body;
  if (typeof on !== "boolean") {
    return res.status(400).json({ success: false, message: "Body must contain { on: true|false }" });
  }

  const ok = await sendTuyaCommand(on);
  if (!ok) {
    return res.status(500).json({ success: false, message: "Tuya command failed" });
  }

  // Optional: log a fresh reading after toggle
  const status = await getDeviceStatusFromTuya();
  if (status) await saveReadingToFirebase(status);

  res.json({ success: true });
});

// Daily / hourly Tuya energy stats
app.get("/api/stats", async (req, res) => {
  const type = req.query.type === "hour" ? "hour" : "day";
  const data = await getTuyaStatistics(type);
  res.json({ success: true, result: data });
});

// -----------------------------------------------------------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
  scheduleAndLoggingLoop();
});
