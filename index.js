const express = require('express');
const app = express();
app.use(express.json());

const AUSPOST_API_KEY = process.env.AUSPOST_API_KEY;
const AUSPOST_PASSWORD = process.env.AUSPOST_PASSWORD;
const AUSPOST_ACCOUNT = process.env.AUSPOST_ACCOUNT;
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const AUSPOST_BASE = 'https://digitalapi.auspost.com.au/shipping/v1';

const auspostHeaders = {
  'Content-Type': 'application/json',
  'Account-Number': AUSPOST_ACCOUNT,
  'Authorization': 'Basic ' + Buffer.from(AUSPOST_API_KEY + ':' + AUSPOST_PASSWORD).toString('base64')
};

const supabaseHeaders = {
  'Content-Type': 'application/json',
  'apikey': SUPABASE_KEY,
  'Authorization': 'Bearer ' + SUPABASE_KEY
};

let shopifyAccessToken = null;

// Helper - get value from Supabase settings table
async function getSetting(key) {
  try {
    var res = await fetch(SUPABASE_URL + '/rest/v1/settings?key=eq.' + key + '&select=value', {
      headers: supabaseHeaders
    });
    var data = await res.json();
    return data && data[0] ? data[0].value : null;
  } catch (err) {
    console.error('Error getting setting:', err);
    return null;
  }
}

// Helper - save value to Supabase settings table
async function saveSetting(key, value) {
  try {
    await fetch(SUPABASE_URL + '/rest/v1/settings?key=eq.' + key, {
      method: 'PATCH',
      headers: supabaseHeaders,
      body: JSON.stringify({ value: value, updated_at: new Date().toISOString() })
    });
  } catch (err) {
    console.error('Error saving setting:', err);
  }
}

// Helper - check if order already processed
async function isOrderProcessed(orderReference) {
  try {
    var res = await fetch(SUPABASE_URL + '/rest/v1/processed_orders?order_reference=eq.' + orderReference + '&select=order_reference', {
      headers: supabaseHeaders
    });
    var data = await res.json();
    return data && data.length > 0;
  } catch (err) {
    console.error('Error checking processed order:', err);
    return false;
  }
}

// Helper - save processed order
async function saveProcessedOrder(orderReference, shipmentId) {
  try {
    await fetch(SUPABASE_URL + '/rest/v1/processed_orders', {
      method: 'POST',
      headers: Object.assign({}, supabaseHeaders, { 'Prefer': 'resolution=merge-duplicates' }),
      body: JSON.stringify({ order_reference: orderReference, shipment_id: shipmentId })
    });
  } catch (err) {
    console.error('Error saving processed order:', err);
  }
}

// Helper - delete processed order record
async function deleteProcessedOrder(orderReference) {
  try {
    await fetch(SUPABASE_URL + '/rest/v1/processed_orders?order_reference=eq.' + orderReference, {
      method: 'DELETE',
      headers: supabaseHeaders
    });
  } catch (err) {
    console.error('Error deleting processed order:', err);
  }
}

// Helper - get all unfulfilled processed orders
async function getUnfulfilledOrders() {
  try {
    var res = await fetch(SUPABASE_URL + '/rest/v1/processed_orders?select=order_reference,shipment_id&fulfilled=eq.false', {
      headers: supabaseHeaders
    });
    var data = await res.json();
    return data || [];
  } catch (err) {
    console.error('Error getting unfulfilled orders:', err);
    return [];
  }
}

// Helper - mark order as fulfilled in Supabase
async function markOrderFulfilled(orderReference) {
  try {
    await fetch(SUPABASE_URL + '/rest/v1/processed_orders?order_reference=eq.' + orderReference, {
      method: 'PATCH',
      headers: supabaseHeaders,
      body: JSON.stringify({ fulfilled: true })
    });
  } catch (err) {
    console.error('Error marking order fulfilled:', err);
  }
}

// Load Shopify token from Supabase on startup
async function loadShopifyToken() {
  var token = await getSetting('shopify_access_token');
  if (token) {
    shopifyAccessToken = token;
    console.log('Shopify access token loaded from Supabase');
  } else {
    console.log('No Shopify access token found in Supabase');
  }
}

loadShopifyToken();

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

// Helper - find and delete AusPost shipment by order reference
async function deleteAusPostShipment(orderReference) {
  try {
    var searchRes = await fetch(AUSPOST_BASE + '/shipments?shipment_reference=' + orderReference, {
      method: 'GET',
      headers: auspostHeaders
    });
    var searchData = await searchRes.json();
    console.log('AusPost shipment search result:', JSON.stringify(searchData));

    var shipmentId = searchData.shipments && searchData.shipments[0] && searchData.shipments[0].shipment_id;

    if (!shipmentId) {
      console.log('No AusPost shipment found for reference:', orderReference);
      return false;
    }

    var deleteRes = await fetch(AUSPOST_BASE + '/shipments/' + shipmentId, {
      method: 'DELETE',
      headers: auspostHeaders
    });
    console.log('AusPost shipment deleted for reference:', orderReference, '| Status:', deleteRes.status);
    await deleteProcessedOrder(orderReference);
    return true;

  } catch (err) {
    console.error('Error deleting AusPost shipment:', err);
    return false;
  }
}

// Background polling job - check for printed labels and update Shopify
async function pollForPrintedLabels() {
  console.log('Polling for printed labels...');

  if (!shopifyAccessToken) {
    console.log('No Shopify token available - skipping poll');
    return;
  }

  try {
    // Get all unfulfilled orders from Supabase
    var res = await fetch(SUPABASE_URL + '/rest/v1/processed_orders?fulfilled=eq.false&select=order_reference,shipment_id', {
      headers: supabaseHeaders
    });
    var orders = await res.json();

    if (!orders || orders.length === 0) {
      console.log('No unfulfilled orders to check');
      return;
    }

    console.log('Unfulfilled orders to check:', orders.length);

    for (var i = 0; i < orders.length; i++) {
      var orderRef = orders[i].order_reference;
      var shipmentId = orders[i].shipment_id;

      if (!shipmentId) {
        console.log('No shipment ID for order:', orderRef, '- skipping');
        continue;
      }

      try {
        // Look up shipment directly by shipment_id
        var shipmentRes = await fetch(AUSPOST_BASE + '/shipments/' + shipmentId, {
          method: 'GET',
          headers: auspostHeaders
        });
        var shipmentData = await shipmentRes.json();
        var shipment = shipmentData.shipments && shipmentData.shipments[0];

        if (!shipment || !shipment.shipment_id) {
          console.log('No shipment found for ID:', shipmentId, '| Response:', JSON.stringify(shipmentData));
          continue;
        }

        var item = shipment.items && shipment.items[0];
        var labelStatus = item && item.label && item.label.status;
        var trackingNumber = item && item.tracking_details && item.tracking_details.article_id;

        console.log('Order:', orderRef, '| Label status:', labelStatus, '| Tracking:', trackingNumber);

        // Always check if already fulfilled in Shopify regardless of label status
        var ordersData = await shopifyAPI('/orders.json?name=' + encodeURIComponent('#' + orderRef) + '&status=any');
        var shopifyOrder = ordersData.orders && ordersData.orders[0];
        if (shopifyOrder && shopifyOrder.fulfillment_status === 'fulfilled') {
          console.log('Order already fulfilled in Shopify:', orderRef);
          await markOrderFulfilled(orderRef);
          continue;
        }

        // Label has been printed if status is Available or Expired
        if ((labelStatus === 'Available' || labelStatus === 'Expired') && trackingNumber) {
          if (!shopifyOrder) {
            console.log('Shopify order not found for:', orderRef);
            await markOrderFulfilled(orderRef);
            continue;
          }

          // Get fulfillment orders first (required for modern Shopify API)
var fulfillmentOrdersData = await shopifyAPI('/orders/' + shopifyOrder.id + '/fulfillment_orders.json');
console.log('Fulfillment orders response:', JSON.stringify(fulfillmentOrdersData));

var fulfillmentOrders = fulfillmentOrdersData.fulfillment_orders;
if (!fulfillmentOrders || fulfillmentOrders.length === 0) {
  console.log('No fulfillment orders found for:', orderRef);
  continue;
}

// Filter to only open fulfillment orders
var openFulfillmentOrders = fulfillmentOrders.filter(function(fo) {
  return fo.status === 'open';
});

if (openFulfillmentOrders.length === 0) {
  console.log('No open fulfillment orders for:', orderRef, '- marking as fulfilled');
  await markOrderFulfilled(orderRef);
  continue;
}

// Create fulfillment using the fulfillment orders API
var lineItems = openFulfillmentOrders.map(function(fo) {
  return { fulfillment_order_id: fo.id };
});

var fulfillmentRes = await shopifyAPI('/fulfillments.json', 'POST', {
  fulfillment: {
    line_items_by_fulfillment_order: lineItems,
    tracking_info: {
      number: trackingNumber,
      company: 'Australia Post',
      url: 'https://auspost.com.au/mypost/track/#/details/' + trackingNumber
    },
    notify_customer: true
  }
});

console.log('Fulfillment response:', JSON.stringify(fulfillmentRes));
console.log('Fulfillment created for order:', orderRef, '| Tracking:', trackingNumber);
await markOrderFulfilled(orderRef);
        }

      } catch (err) {
        console.error('Error processing order:', orderRef, err);
      }

      // Small delay between orders to avoid rate limiting
      await new Promise(function(resolve) { setTimeout(resolve, 500); });
    }

  } catch (err) {
    console.error('Polling error:', err);
  }
}

// Run polling every 5 minutes
setInterval(pollForPrintedLabels, 5 * 60 * 1000);
// Also run once on startup after a short delay
setTimeout(pollForPrintedLabels, 10000);

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
    await saveSetting('shopify_access_token', shopifyAccessToken);
    console.log('Shopify access token obtained and saved to Supabase');
    res.send('Shopify connected successfully! You can close this window.');
  } catch (err) {
    console.error('Auth error:', err);
    res.send('Auth failed - check your logs');
  }
});

app.post('/webhook/order', async function(req, res) {
  res.sendStatus(200);

  var order = req.body;
  var shipping = order.shipping_address;

  if (!shipping) {
    console.log('No shipping address on order, skipping');
    return;
  }

  try {
    var orderReference = order.name ? order.name.replace('#', '') : String(order.order_number);

    var alreadyProcessed = await isOrderProcessed(orderReference);
    if (alreadyProcessed) {
      console.log('Order already processed:', orderReference, '- skipping');
      return;
    }

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
        shipment_reference: orderReference,
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

    var shipmentId = shipmentData.shipments && shipmentData.shipments[0] && shipmentData.shipments[0].shipment_id;
    await saveProcessedOrder(orderReference, shipmentId || '');

  } catch (err) {
    console.error('Order webhook error:', err);
  }
});

app.post('/webhook/fulfillment', async function(req, res) {
  var fulfillment = req.body;
  console.log('Fulfillment name field:', fulfillment.name);
  console.log('Fulfillment tracking company:', fulfillment.tracking_company);

  var trackingCompany = fulfillment.tracking_company || '';
  if (trackingCompany.toLowerCase().indexOf('australia post') !== -1) {
    console.log('Fulfillment is from Australia Post/Parcel Send - skipping deletion');
    return res.sendStatus(200);
  }

  var orderReference = fulfillment.name ? fulfillment.name.replace('#', '').split('.')[0] : null;
  console.log('Fulfillment received for order:', orderReference);
  if (orderReference) {
    await deleteAusPostShipment(orderReference);
  }
  res.sendStatus(200);
});

app.post('/webhook/order-cancelled', async function(req, res) {
  var order = req.body;
  var orderReference = order.name ? order.name.replace('#', '') : String(order.order_number);
  console.log('Order cancelled:', orderReference);
  if (orderReference) {
    await deleteAusPostShipment(orderReference);
  }
  res.sendStatus(200);
});

app.post('/webhook/order-deleted', async function(req, res) {
  var order = req.body;
  var orderReference = order.name ? order.name.replace('#', '') : String(order.order_number);
  console.log('Order deleted:', orderReference);
  if (orderReference) {
    await deleteAusPostShipment(orderReference);
  }
  res.sendStatus(200);
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
