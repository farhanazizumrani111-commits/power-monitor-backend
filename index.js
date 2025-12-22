// ==========================================================
// index.js — Power Monitor Backend (MODE A)
// ==========================================================
// - Polls Tuya smart plug every minute
// - Saves readings to Firebase Realtime DB
// - Detects ONLINE / OFFLINE
// - Enforces schedule from /schedule
// - Listens to /control/command from Flutter
// ==========================================================

const axios = require('axios');
const crypto = require('crypto');
const admin = require('firebase-admin');

// ----------------------------------------------------------
// FIREBASE ADMIN (Render-safe, NO local JSON required)
// ----------------------------------------------------------

let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
} else {
  // Local development fallback ONLY
  serviceAccount = require('./serviceAccountKey.json');
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL:
    process.env.FIREBASE_DB_URL ||
    'https://power-monitoring-b3f6d-default-rtdb.asia-southeast1.firebasedatabase.app/',
});

const db = admin.database();

// ----------------------------------------------------------
// TUYA CONFIG
// ----------------------------------------------------------

const TUYA_CLIENT_ID = '5urvraenffcq579wss7f';
const TUYA_SECRET = '168f6566bcc74c8f9f050b579e33c13d';
const DEVICE_ID = 'eba98daf700c720018hrla';
const TUYA_BASE_URL = 'https://openapi.tuyaus.com';

const LOAD_THRESHOLD_W = 5; // ✅ load detection

let accessToken = null;
let lastKnownRelay = false;
let scheduleConfig = null;

// ----------------------------------------------------------
// HELPERS
// ----------------------------------------------------------

function sign(content, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(content, 'utf8')
    .digest('hex')
    .toUpperCase();
}

async function getAccessToken() {
  const t = Date.now().toString();
  const path = '/v1.0/token?grant_type=1';
  const hash = crypto.createHash('sha256').update('').digest('hex');
  const str = `${TUYA_CLIENT_ID}${t}GET\n${hash}\n\n${path}`;
  const s = sign(str, TUYA_SECRET);

  const res = await axios.get(`${TUYA_BASE_URL}${path}`, {
    headers: {
      client_id: TUYA_CLIENT_ID,
      sign: s,
      t,
      sign_method: 'HMAC-SHA256',
    },
  });

  if (!res.data.success) {
    throw new Error(res.data.msg);
  }

  accessToken = res.data.result.access_token;
  console.log('✅ Tuya token OK');
}

async function ensureToken() {
  if (!accessToken) await getAccessToken();
}

// ----------------------------------------------------------
// TUYA API
// ----------------------------------------------------------

async function getDeviceStatus() {
  await ensureToken();

  const t = Date.now().toString();
  const path = `/v1.0/devices/${DEVICE_ID}/status`;
  const hash = crypto.createHash('sha256').update('').digest('hex');
  const str = `${TUYA_CLIENT_ID}${accessToken}${t}GET\n${hash}\n\n${path}`;
  const s = sign(str, TUYA_SECRET);

  const res = await axios.get(`${TUYA_BASE_URL}${path}`, {
    headers: {
      client_id: TUYA_CLIENT_ID,
      access_token: accessToken,
      sign: s,
      t,
      sign_method: 'HMAC-SHA256',
    },
  });

  if (!res.data.success) {
    if (res.data.code === 1010) {
      accessToken = null;
      return getDeviceStatus();
    }
    throw new Error(res.data.msg);
  }

  let voltage = 0,
    current = 0,
    power = 0,
    isOn = false;

  for (const item of res.data.result) {
    if (item.code === 'cur_voltage') voltage = item.value / 10;
    if (item.code === 'cur_current') current = item.value / 1000;
    if (item.code === 'cur_power') power = item.value / 10;
    if (item.code === 'switch_1') isOn = item.value;
  }

  const loadOn = isOn && power >= LOAD_THRESHOLD_W;

  return { voltage, current, power, isOn, loadOn };
}

async function toggleRelay(turnOn, source) {
  await ensureToken();

  const t = Date.now().toString();
  const path = `/v1.0/devices/${DEVICE_ID}/commands`;
  const body = { commands: [{ code: 'switch_1', value: !!turnOn }] };
  const json = JSON.stringify(body);
  const hash = crypto.createHash('sha256').update(json).digest('hex');
  const str = `${TUYA_CLIENT_ID}${accessToken}${t}POST\n${hash}\n\n${path}`;
  const s = sign(str, TUYA_SECRET);

  await axios.post(`${TUYA_BASE_URL}${path}`, body, {
    headers: {
      client_id: TUYA_CLIENT_ID,
      access_token: accessToken,
      sign: s,
      t,
      sign_method: 'HMAC-SHA256',
      'Content-Type': 'application/json',
    },
  });

  lastKnownRelay = !!turnOn;
  await db.ref('control/lastAction').set({
    turnOn,
    source,
    at: admin.database.ServerValue.TIMESTAMP,
  });

  console.log(`⚡ Relay ${turnOn ? 'ON' : 'OFF'} (${source})`);
}

// ----------------------------------------------------------
// FIREBASE WATCHERS
// ----------------------------------------------------------

db.ref('schedule').on('value', (s) => {
  scheduleConfig = s.val();
  console.log('🗓️ Schedule updated');
});

db.ref('control/command').on('value', async (s) => {
  const cmd = s.val();
  if (!cmd) return;
  if (cmd.turnOn === lastKnownRelay) return;
  await toggleRelay(cmd.turnOn, 'app');
});

// ----------------------------------------------------------
// SCHEDULE LOGIC
// ----------------------------------------------------------

function isWithinSchedule(now, cfg) {
  if (!cfg || !cfg.isEnabled) return false;
  if (!cfg.days?.[now.getDay()]) return false;

  const [sh, sm] = cfg.start.split(':').map(Number);
  const [eh, em] = cfg.end.split(':').map(Number);

  const nowM = now.getHours() * 60 + now.getMinutes();
  const sM = sh * 60 + sm;
  const eM = eh * 60 + em;

  return sM <= eM
    ? nowM >= sM && nowM < eM
    : nowM >= sM || nowM < eM;
}

async function enforceSchedule() {
  if (!scheduleConfig?.isEnabled) return;
  const shouldBeOn = isWithinSchedule(new Date(), scheduleConfig);
  if (shouldBeOn !== lastKnownRelay) {
    await toggleRelay(shouldBeOn, 'schedule');
  }
}

// ----------------------------------------------------------
// MAIN LOOP
// ----------------------------------------------------------

async function pollAndSave() {
  try {
    const d = await getDeviceStatus();
    lastKnownRelay = d.isOn;

    const data = {
      voltage: d.voltage,
      current: d.current,
      power: d.power,
      is_on: d.isOn,
      load_on: d.loadOn,
      timestamp: admin.database.ServerValue.TIMESTAMP,
    };

    await db.ref('readings').push(data);
    await db.ref('status/current').set({
      ...data,
      deviceOnline: true,
    });

    console.log(
      `📥 ${d.voltage}V ${d.current}A ${d.power}W load=${d.loadOn}`,
    );
  } catch (e) {
    console.error('❌ Device offline');
    await db.ref('status/current').update({
      deviceOnline: false,
      errorAt: admin.database.ServerValue.TIMESTAMP,
    });
  }
}

// ----------------------------------------------------------
// START
// ----------------------------------------------------------

console.log('🚀 Backend started (MODE A)');
setInterval(pollAndSave, 60 * 1000);
setInterval(enforceSchedule, 30 * 1000);
