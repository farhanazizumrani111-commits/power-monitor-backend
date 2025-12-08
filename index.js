const axios = require('axios');
const crypto = require('crypto');
const admin = require('firebase-admin');
const express = require('express');

// --- CONFIGURATION ---
const TUYA_CLIENT_ID = '5urvraenffcq579wss7f';
const TUYA_SECRET = '168f6566bcc74c8f9f050b579e33c13d';
const DEVICE_ID = 'eba98daf700c720018hrla';
const TUYA_BASE_URL = 'https://openapi.tuyaus.com';

// --- FIREBASE SETUP ---
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  try {
    serviceAccount = require('./service-account.json');
  } catch (e) {
    console.error("ERROR: Could not find 'service-account.json'");
    process.exit(1);
  }
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://power-monitoring-b3f6d-default-rtdb.asia-southeast1.firebasedatabase.app/"
});

const db = admin.database();
let accessToken = null;

// --- TUYA HELPERS ---
function calculateSign(content, secret) {
  return crypto.createHmac('sha256', secret).update(content, 'utf8').digest('hex').toUpperCase();
}

async function getAccessToken() {
  const timestamp = Date.now().toString();
  const path = '/v1.0/token?grant_type=1';
  const emptyHash = crypto.createHash('sha256').update('').digest('hex');
  const signStr = `${TUYA_CLIENT_ID}${timestamp}GET\n${emptyHash}\n\n${path}`;
  const sign = calculateSign(signStr, TUYA_SECRET);

  try {
    const res = await axios.get(`${TUYA_BASE_URL}${path}`, {
      headers: { client_id: TUYA_CLIENT_ID, sign: sign, t: timestamp, sign_method: 'HMAC-SHA256' }
    });
    if (res.data.success) {
      accessToken = res.data.result.access_token;
      return true;
    }
  } catch (e) {
    console.error('Token Error:', e.message);
  }
  return false;
}

// --- MAIN LOOP ---
async function fetchAndSave() {
  if (!accessToken) await getAccessToken();

  const timestamp = Date.now().toString();
  const path = `/v1.0/devices/${DEVICE_ID}/status`;
  const emptyHash = crypto.createHash('sha256').update('').digest('hex');
  const signStr = `${TUYA_CLIENT_ID}${accessToken}${timestamp}GET\n${emptyHash}\n\n${path}`;
  const sign = calculateSign(signStr, TUYA_SECRET);

  try {
    const res = await axios.get(`${TUYA_BASE_URL}${path}`, {
      headers: { client_id: TUYA_CLIENT_ID, access_token: accessToken, sign: sign, t: timestamp, sign_method: 'HMAC-SHA256' }
    });

    if (res.data.success) {
      const statusList = res.data.result;
      let data = { voltage: 0, current: 0, power: 0, is_on: false };

      statusList.forEach(item => {
        if (item.code === 'cur_voltage') data.voltage = item.value / 10.0;
        if (item.code === 'cur_current') data.current = item.value / 1000.0;
        if (item.code === 'cur_power') data.power = item.value / 10.0;
        if (item.code === 'switch_1') data.is_on = item.value;
      });

      data.timestamp = admin.database.ServerValue.TIMESTAMP;
      await db.ref('readings').push().set(data);
      console.log(`✅ Reading: ${data.power}W | ${data.is_on ? 'ON' : 'OFF'}`);

      // 🟢 NEW: CHECK SCHEDULE
      await checkSchedule(data.is_on);

    } else {
      console.log('Tuya Error:', res.data.msg);
      if (res.data.code === 1010) accessToken = null; 
    }
  } catch (e) {
    console.error('Fetch Error:', e.message);
    accessToken = null; 
  }
}

// 🟢 NEW: Check Schedule Logic
async function checkSchedule(currentStatus) {
  try {
    const snapshot = await db.ref('schedule').once('value');
    const schedule = snapshot.val();

    if (!schedule || !schedule.isEnabled) return;

    // Get current time in User's Timezone (Asia/Kuala_Lumpur)
    const now = new Date();
    const timeString = now.toLocaleTimeString('en-US', { 
      timeZone: 'Asia/Kuala_Lumpur', 
      hour12: false, 
      hour: '2-digit', 
      minute: '2-digit' 
    });

    // If Current Time == Scheduled Time
    if (timeString === schedule.time) {
      // Only execute if the status is DIFFERENT (Don't turn ON if already ON)
      if (currentStatus !== schedule.action) {
        console.log(`⏰ SCHEDULE MATCH! Time: ${timeString}. Turning ${schedule.action ? 'ON' : 'OFF'}`);
        await toggleDevice(schedule.action);
      }
    }
  } catch (e) {
    console.error("Schedule Error:", e);
  }
}

// 🟢 NEW: Toggle Helper
async function toggleDevice(turnOn) {
  if (!accessToken) await getAccessToken();
  const timestamp = Date.now().toString();
  const path = `/v1.0/devices/${DEVICE_ID}/commands`;
  const body = { "commands": [{ "code": "switch_1", "value": turnOn }] };
  const jsonBody = JSON.stringify(body);
  const contentHash = crypto.createHash('sha256').update(jsonBody).digest('hex');
  const signStr = `${TUYA_CLIENT_ID}${accessToken}${timestamp}POST\n${contentHash}\n\n${path}`;
  const sign = calculateSign(signStr, TUYA_SECRET);

  try {
    await axios.post(`${TUYA_BASE_URL}${path}`, body, {
      headers: { client_id: TUYA_CLIENT_ID, access_token: accessToken, sign: sign, t: timestamp, sign_method: 'HMAC-SHA256' }
    });
    console.log("👉 Command Sent Successfully");
  } catch (e) {
    console.error("Command Failed:", e.message);
  }
}

// --- SERVER SETUP ---
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Power Monitor Running'));
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  fetchAndSave(); 
  setInterval(fetchAndSave, 60 * 1000); 
});
