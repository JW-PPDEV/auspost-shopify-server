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

// Store access token in memory
let shopifyAccessToken = null;

// ✅ Health check
app.get('/', (req, res) => {
  res.send('AusPost-Shopify server is running!');
});

// ✅ OAuth callback - Shopify sends token here after install
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
    res.send('✅ Shopify connected successfully! You can close this window.');
  } catch (err) {
    console.error('Auth error:', err);
    res.send('❌ Auth failed - check your logs');
  }
});

// ✅ Helper - make authenticated Shopify API calls
async function shopifyAPI(endpoint, method = 'GET', body = null) {
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': shopifyAccessToken
    }
  };
  if (body) options.body = JSON.stringify(body);

  const response = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04${endpoint}`, options);
  return response.json();
}

// ✅ Webhook - create shipment in AusPost when order is placed
app.post('/webhook/order', async (req, res) => {
  const order = req.body;
  const shipping = order.shipping_address;

  if (!shipping) {
    console.log('No shipping address on order, skipping');
    return res.sendStatus(200);
  }

  try {
    // Determine service based on what customer selected at checkout
    const shippingLine = order.shipping_lines?.[0]?.title || '';
    const isExpress = shippingLine.toLowerCase().includes('express');
    const productId = isExpress ? '3K55' : '7E55';

    // Create shipment in AusPost (appears in Parcel Send)
    const shipmentRes = await fetch(`${AUSPOST_BASE}/shipments`, {
      method: 'POST',
      headers: auspostHeaders,
      body: JSON.stringify({
        shipments: [{
          shipment_reference: String(order.order_number),
          sender: {
            name: process.env.SENDER_NAME,
            lines: [process.env.SENDER_ADDRESS],
            suburb: process.env.SENDER_SUBURB,
            state: process.env.SENDER_STATE,
            postcode: process.env.SENDER_POSTCODE,
            country: 'AU',
            phone: process.env.SENDER_PHONE
          },
          receiver: {
            name: `${shipping.first_name} ${shipping.last_name}`,
            lines: [shipping.address1, shipping.address2].filter(Boolean),
            suburb: shipping.city,
            state: shipping.province_code,
            postcode: shipping.zip,
            country: shipping.country_code,
            phone: shipping.phone || order.phone || '0400000000',
            email: order.email
          },
          items: [{
            item_reference: `item-${order.order_number}`,
            product_id: productId,
            length: 40,
            width: 30,
            height: 5,
            weight: 0
