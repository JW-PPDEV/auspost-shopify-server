const express = require('express');
const app = express();
app.use(express.json());

const AUSPOST_API_KEY = process.env.AUSPOST_API_KEY;
const AUSPOST_PASSWORD = process.env.AUSPOST_PASSWORD;
const AUSPOST_ACCOUNT = process.env.AUSPOST_ACCOUNT;
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;

const AUSPOST_BASE = 'https://digitalapi.auspost.com.au/test/shipping/v1';

const auspostHeaders = {
  'Content-Type': 'application/json',
  'Account-Number': AUSPOST_ACCOUNT,
  'Authorization': 'Basic ' + Buffer.from(`${AUSPOST_API_KEY}:${AUSPOST_PASSWORD}`).toString('base64')
};

let shopifyAccessToken = null;

app.get('/', (req, res) => {
  res.send('AusPost-Shopify server is running!');
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const response = await fetch(`https://${SHOPIFY_STORE}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_CLIENT_SECRET,
        code
      })
    });
    const data = await response.json();
    shopifyAccessToken = data.access_token;
    console.log('Shopify access token obtained successfully');
    res.send('Shopify connected successfully! You can close this window.');
  } catch (err) {
    console.error('Auth error:', err);
    res.send('Auth failed - check your logs');
  }
});

async function shopifyAPI(endpoint, method, body) {
  method = method || 'GET';
  const options = {
    method: method,
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': shopifyAccessToken
    }
  };
  if (body) {
    options.body = JSON.stringify(body);
  }
  const response = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04${endpoint}`, options);
  return response.json();
}

app.post('/webhook/
