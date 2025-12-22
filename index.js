// index.js – Power Monitor Backend (Mode A)
// ----------------------------------------
// - Polls Tuya smart plug and writes readings to Firebase Realtime DB
// - Writes /status/current for Flutter to read (single source of truth)
// - Enforces schedule from /schedule
// - Listens to /control/command for manual ON/OFF (from Flutter app)

const axios = require('axios');
const crypto = require('crypto');
const admin = require('firebase-admin');

// 1) Load Firebase service account JSON (DO NOT COMMIT THIS FILE)
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL:
    'https://power-monitoring-b3f6d-default-rtdb.asia-southeast1.firebasedatabase.app/',
});

const db = admin.database();

// -----------------------------------------------------------
// TUYA CONFIG
// -----------------------------------------------------------
const clientId = '5urvraenffcq579wss7f';
const clientSecret = '168f6566bcc74c8f9f050b579e33c13d';
const deviceId = 'eba98daf700c720018hrla';
const baseUrl = 'https://openapi.tuyaus.com';

let accessToken = null;
const LOAD_THRESHOLD_W = 5;

// Polling intervals
const POLL_MS = 10 * 1000; // 10s (full-time monitoring)
const SCHEDULE_MS = 15 * 1000; // 15s

// -----------------------------------------------------------
// TUYA SIGNING HELPERS
// -----------------------------------------------------------
function calculateSign(content, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(content, 'utf8')
    .digest('hex')
    .toUpperCase();
}

async function refreshAccessToken() {
  const timestamp = Date.now();
  const emptyBodyHash =
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

  const stringToSign =
    clientId +
    timestamp +
    'GET\n' +
    emptyBodyHash +
    '\n\n' +
    '/v1.0/token?grant_type=1';

  const sign = calculateSign(stringToSign, clientSecret);

  const res = await axios.get(`${baseUrl}/v1.0/token?grant_type=1`, {
    headers: {
      client_id: clientId,
      sign: sign,
      t: String(timestamp),
      sign_method: 'HMAC-SHA256',
    },
    timeout: 10000,
  });

  if (!res.data.success) throw new Error(`Token error: ${res.data.msg}`);

  accessToken = res.data.result.access_token;
  console.log('✅ Got Tuya access token');
  return accessToken;
}

async function ensureToken() {
  if (!accessToken) await refreshAccessToken();
}

// -----------------------------------------------------------
// TUYA API FUNCTIONS
// -----------------------------------------------------------
async function getDeviceStatus() {
  await ensureToken();

  const timestamp = Date.now();
  const path = `/v1.0/devices/${deviceId}/status`;
  const emptyBodyHash =
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

  const stringToSign =
    clientId +
    accessToken +
    timestamp +
    'GET\n' +
    emptyBodyHash +
    '\n\n' +
    path;

  const sign = calculateSign(stringToSign, clientSecret);

  const res = await axios.get(`${baseUrl}${path}`, {
    headers: {
      client_id: clientId,
      access_token: accessToken,
      sign: sign,
      t: String(timestamp),
      sign_method: 'HMAC-SHA256',
    },
    timeout: 10000,
  });

  if (!res.data.success) {
    // token expired
    if (res.data.code === '1010' || res.data.code === 1010) {
      accessToken = null;
      await ensureToken();
      return await getDeviceStatus();
    }
    throw new Error(res.data.msg || 'Failed to get status');
  }

  const list = res.data.result || [];
  let voltage = 0;
  let current = 0;
  let power = 0;
  let isOn = false;

  for (const item of list) {
    const code = item.code;
    const value = item.value;

    if (code === 'cur_voltage') voltage = Number(value) / 10.0;
    if (code === 'cur_current') current = Number(value) / 1000.0;
    if (code === 'cur_power') power = Number(value) / 10.0;
    if (code === 'switch_1') isOn = !!value;
  }

  const loadOn = isOn && power >= LOAD_THRESHOLD_W;
  return { voltage, current, power, isOn, loadOn };
}

async function sendToggleCommand(turnOn, source = 'manual') {
  await ensureToken();

  const timestamp = Date.now();
  const path = `/v1.0/devices/${deviceId}/commands`;

  const body = { commands: [{ code: 'switch_1', value: !!turnOn }] };
  const jsonBody = JSON.stringify(body);

  const contentHash = crypto
    .createHash('sha256')
    .update(jsonBody, 'utf8')
    .digest('hex');

  const stringToSign =
    clientId +
    accessToken +
    timestamp +
    'POST\n' +
    contentHash +
    '\n\n' +
    path;

  const sign = calculateSign(stringToSign, clientSecret);

  const res = await axios.post(`${baseUrl}${path}`, body, {
    headers: {
      client_id: clientId,
      access_token: accessToken,
      sign: sign,
      t: String(timestamp),
      sign_method: 'HMAC-SHA256',
      'Content-Type': 'application/json',
    },
    timeout: 10000,
  });

  if (!res.data.success) throw new Error(res.data.msg || 'Toggle failed');

  console.log(`⚡ Tuya switch_1 => ${turnOn ? 'ON' : 'OFF'} by ${source}`);
  await db.ref('control/lastAction').set({
    turnOn: !!turnOn,
    source,
    at: admin.database.ServerValue.TIMESTAMP,
  });
}

// -----------------------------------------------------------
// FIREBASE REFS
// -----------------------------------------------------------
const readingsRef = db.ref('readings');
const statusRef = db.ref('status/current');
const scheduleRef = db.ref('schedule');
const commandRef = db.ref('control/command');

let lastKnownRelay = false;
let scheduleConfig = null;

// Watch schedule config
scheduleRef.on(
  'value',
  (snap) => {
    scheduleConfig = snap.val();
    console.log('🗓️ Schedule updated:', scheduleConfig);
  },
  (err) => console.error('Schedule watch error', err),
);

// Watch manual commands (Flutter writes this)
commandRef.on(
  'value',
  async (snap) => {
    const cmd = snap.val();
    if (!cmd) return;

    try {
      const desired = !!cmd.turnOn;
      await sendToggleCommand(desired, 'app');

      // clear command so it won’t re-run
      await commandRef.remove();

      lastKnownRelay = desired;
    } catch (err) {
      console.error('Error handling manual command:', err.message || err);
    }
  },
  (err) => console.error('Command watch error', err),
);

// -----------------------------------------------------------
// POLL STATUS AND WRITE TO FIREBASE
// -----------------------------------------------------------
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
      lastError: null,
    });

    console.log(
      `📥 V=${data.voltage.toFixed(1)}V I=${data.current.toFixed(3)}A P=${data.power.toFixed(
        1,
      )}W load_on=${data.loadOn}`,
    );
  } catch (err) {
    console.error('pollStatus error:', err.message || err);

    // mark offline so Flutter shows OFFLINE
    await statusRef.set({
      voltage: 0,
      current: 0,
      power: 0,
      is_on: false,
      load_on: false,
      deviceOnline: false,
      lastError: String(err.message || err),
      timestamp: admin.database.ServerValue.TIMESTAMP,
    });
  }
}

// -----------------------------------------------------------
// SCHEDULE ENFORCEMENT
// -----------------------------------------------------------
function isWithinSchedule(now, cfg) {
  if (!cfg || !cfg.isEnabled) return false;

  const days = Array.isArray(cfg.days) ? cfg.days : [];
  const todayIndex = now.getDay(); // 0=Sun..6=Sat
  if (!days[todayIndex]) return false;

  const start = typeof cfg.start === 'string' ? cfg.start : '08:00';
  const end = typeof cfg.end === 'string' ? cfg.end : '21:00';

  const [sh, sm] = start.split(':').map((x) => parseInt(x, 10));
  const [eh, em] = end.split(':').map((x) => parseInt(x, 10));

  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;
  const nowMin = now.getHours() * 60 + now.getMinutes();

  if (startMin <= endMin) {
    return nowMin >= startMin && nowMin < endMin;
  } else {
    return nowMin >= startMin || nowMin < endMin; // overnight
  }
}

async function enforceSchedule() {
  if (!scheduleConfig || !scheduleConfig.isEnabled) return;

  try {
    const now = new Date();
    const shouldBeOn = isWithinSchedule(now, scheduleConfig);

    if (shouldBeOn === lastKnownRelay) return;

    await sendToggleCommand(shouldBeOn, 'schedule');
    lastKnownRelay = shouldBeOn;

    console.log(`🕒 Schedule enforced => ${shouldBeOn ? 'ON' : 'OFF'}`);
  } catch (err) {
    console.error('enforceSchedule error:', err.message || err);
  }
}

// -----------------------------------------------------------
// MAIN
// -----------------------------------------------------------
(async function main() {
  console.log('🚀 Power monitor backend starting (Mode A)...');
  try {
    await ensureToken();
  } catch (e) {
    console.error('Initial token fetch failed:', e.message || e);
  }

  setInterval(pollStatusAndSave, POLL_MS);
  setInterval(enforceSchedule, SCHEDULE_MS);

  // immediate first run
  pollStatusAndSave();
})();
