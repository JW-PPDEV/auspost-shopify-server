const express = require('express');
const app = express();
const fs = require('fs');
app.use(express.json());

const AUSPOST_API_KEY = process.env.AUSPOST_API_KEY;
const AUSPOST_PASSWORD = process.env.AUSPOST_PASSWORD;
const AUSPOST_ACCOUNT = process.env.AUSPOST_ACCOUNT;
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;

const AUSPOST_BASE = 'https://digitalapi.auspost.com.au/shipping/v1';
const SHIPMENTS_FILE = '/tmp/shipments.json';

const auspostHeaders = {
  'Content-Type': 'application/json',
  'Account-Number': AUSPOST_ACCOUNT,
  'Authorization': 'Basic ' + Buffer.from(AUSPOST_API_KEY + ':' + AUSPOST_PASSWORD).toString('base64')
};

let shopifyAccessToken = null;

// Helper - load shipments from file
function loadShipments() {
  try {
    if (fs.existsSync(SHIPMENTS_FILE)) {
      return JSON.parse(fs.readFileSync(SHIPMENTS_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Error loading shipments file:', err);
  }
  return {};
}

// Helper - save shipments to file
function saveShipments(shipments) {
  try {
    fs.writeFileSync(SHIPMENTS_FILE, JSON.stringify(shipments));
  } catch (err) {
    console.error('Error saving shipments file:', err);
  }
}

app.get('/', function(req, res) {
  var shop = req.query.shop;
  if (shop) {
    res.send('<html><body><script>window.top.location.href = "https://' + shop + '/admin";</script></body></html>');
  } else {
    res.send('AusPost-Shopify server is running!');
  }
});

app.get('/auth/callback', async function(req, res) {
  var code = req.query.code;
  try {
    var response = await fetch('https://' + SHOPIFY_STORE + '/admin/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_CLIENT_SECRET,
        code: code
      })
    });
    var data = await response.json();
    shopifyAccessToken = data.access_token;
    console.log('Shopify access token obtained successfully');
    res.send('Shopify connected successfully! You can close this window.');
  } catch (err) {
    console.error('Auth error:', err);
    res.send('Auth failed - check your logs');
  }
});

async function shopifyAPI(endpoint, method, body) {
  if (!method) { method = 'GET'; }
  var options = {
    method: method,
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': shopifyAccessToken
    }
  };
  if (body) { options.body = JSON.stringify(body); }
  var response = await fetch('https://' + SHOPIFY_STORE + '/admin/api/2026-04' + endpoint, options);
  return response.json();
}

app.post('/webhook/order', async function(req, res) {
  var order = req.body;
  var shipping = order.shipping_address;

  if (!shipping) {
    console.log('No shipping address on order, skipping');
    return res.sendStatus(200);
  }

  try {
    var shippingTitle = '';
    if (order.shipping_lines && order.shipping_lines[0]) {
      shippingTitle = order.shipping_lines[0].title;
    }

    var destinationCountry = shipping.country_code;
    var isInternational = destinationCountry !== 'AU';
    var isExpress = shippingTitle.toLowerCase().indexOf('express') !== -1;

    var productId;
    if (isInternational) {
      productId = 'PTI8';
    } else {
      productId = isExpress ? '3J55' : '3D55';
    }

    var address2 = shipping.address2 || '';
    var lines = [shipping.address1];
    if (address2) { lines.push(address2); }

    var itemPayload = {
      item_reference: 'item-' + order.order_number,
      product_id: productId,
      length: 40,
      width: 30,
      height: 5,
      weight: 0.5
    };

    if (isInternational) {
      itemPayload.commercial_value = true;
      itemPayload.classification_type = 'SALE_OF_GOODS';
      itemPayload.item_contents = [{
        description: 'Clothing',
        quantity: 1,
        weight: 0.5,
        value: parseFloat(order.total_price) || 50,
        country_of_origin: 'AU',
        hs_tariff_code: ''
      }];
    } else {
      itemPayload.authority_to_leave = true;
    }

    var shipmentPayload = {
      shipments: [{
        shipment_reference: String(order.order_number),
        from: {
          name: process.env.SENDER_NAME,
          lines: [process.env.SENDER_ADDRESS],
          suburb: process.env.SENDER_SUBURB,
          state: process.env.SENDER_STATE,
          postcode: process.env.SENDER_POSTCODE,
          country: 'AU',
          phone: process.env.SENDER_PHONE
        },
        to: {
          name: shipping.first_name + ' ' + shipping.last_name,
          lines: lines,
          suburb: shipping.city,
          state: shipping.province_code,
          postcode: shipping.zip,
          country: shipping.country_code,
          phone: shipping.phone || order.phone || '0400000000',
          email: order.email
        },
        items: [itemPayload]
      }]
    };

    console.log('Sending to AusPost:', JSON.stringify(shipmentPayload));

    var shipmentRes = await fetch(AUSPOST_BASE + '/shipments', {
      method: 'POST',
      headers: auspostHeaders,
      body: JSON.stringify(shipmentPayload)
    });

    var shipmentData = await shipmentRes.json();
    console.log('AusPost shipment created:', JSON.stringify(shipmentData));

    // Save shipment ID mapped to order number
    var shipmentId = shipmentData.shipments && shipmentData.shipments[0] && shipmentData.shipments[0].shipment_id;
    if (shipmentId) {
      var shipments = loadShipments();
      shipments[String(order.order_number)] = shipmentId;
      saveShipments(shipments);
      console.log('Saved shipment ID ' + shipmentId + ' for order ' + order.order_number);
    }

    res.sendStatus(200);

  } catch (err) {
    console.error('Order webhook error:', err);
    res.sendStatus(200);
  }
});

// Fulfillment webhook - delete AusPost shipment if fulfilled outside Parcel Send
app.post('/webhook/fulfillment', async function(req, res) {
  console.log('Raw fulfillment body:', JSON.stringify(req.body));
  var fulfillment = req.body;
  console.log('Fulfillment paylod:', JSON.stringify(fulfillment));
  var orderNumber = fulfillment.name ? fulfillment.name.replace('#', '').split('.')[0] : null;

  console.log('Fulfillment received for order:', orderNumber);

  try {
    var shipments = loadShipments();
    var shipmentId = shipments[String(orderNumber)];

    if (!shipmentId) {
      console.log('No AusPost shipment found for order:', orderNumber);
      return res.sendStatus(200);
    }

    // Delete the shipment from AusPost
    var deleteRes = await fetch(AUSPOST_BASE + '/shipments/' + shipmentId, {
      method: 'DELETE',
      headers: auspostHeaders
    });

    console.log('AusPost shipment deleted for order:', orderNumber, '| Status:', deleteRes.status);

    // Remove from our records
    delete shipments[String(orderNumber)];
    saveShipments(shipments);

    res.sendStatus(200);

  } catch (err) {
    console.error('Fulfillment webhook error:', err);
    res.sendStatus(200);
  }
});

app.post('/webhook/tracking', async function(req, res) {
  var tracking_number = req.body.tracking_number;
  var order_number = req.body.order_number;

  if (!shopifyAccessToken) {
    console.error('No Shopify access token available');
    return res.sendStatus(500);
  }

  try {
    var ordersData = await shopifyAPI('/orders.json?name=' + order_number + '&status=any');
    var order = ordersData.orders && ordersData.orders[0];

    if (!order) {
      console.error('Order not found:', order_number);
      return res.sendStatus(404);
    }

    await shopifyAPI('/orders/' + order.id + '/fulfillments.json', 'POST', {
      fulfillment: {
        tracking_number: tracking_number,
        tracking_company: 'Australia Post',
        tracking_url: 'https://auspost.com.au/mypost/track/#/details/' + tracking_number,
        notify_customer: true
      }
    });

    console.log('Tracking ' + tracking_number + ' added to order ' + order_number);
    res.sendStatus(200);

  } catch (err) {
    console.error('Tracking webhook error:', err);
    res.sendStatus(500);
  }
});

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log('Server running on port ' + PORT);
});
