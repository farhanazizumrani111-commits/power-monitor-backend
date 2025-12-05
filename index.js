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
// We check if we are on Render (Cloud) or Local (Your PC)
let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  // If running on Render, parse the environment variable string
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  // If running locally, look for the file
  try {
    serviceAccount = require('./service-account.json');
  } catch (e) {
    console.error("ERROR: Could not find 'service-account.json'. Make sure you downloaded it from Firebase!");
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

async function fetchAndSave() {
  console.log("Fetching data from Tuya...");
  if (!accessToken) {
    await getAccessToken();
  }

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

      // Add timestamp
      data.timestamp = admin.database.ServerValue.TIMESTAMP;

      // Save to Firebase
      await db.ref('readings').push().set(data);
      console.log(`✅ Saved Reading: ${data.power}W | ${data.voltage}V`);
    } else {
      console.log('❌ Tuya Error:', res.data.msg);
      if (res.data.code === 1010) accessToken = null; 
    }
  } catch (e) {
    console.error('❌ Fetch Error:', e.message);
    accessToken = null; 
  }
}

// --- START SERVER ---
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Power Monitor Backend is Running');
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  
  // Run immediately on start
  fetchAndSave(); 
  
  // Then run every 60 seconds
  setInterval(fetchAndSave, 60 * 1000); 
});