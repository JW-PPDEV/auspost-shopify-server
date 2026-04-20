const express = require('express');
const app = express();
app.use(express.json());

const AUSPOST_API_KEY = process.env.AUSPOST_API_KEY;
const AUSPOST_PASSWORD = process.env.AUSPOST_PASSWORD;
const AUSPOST_ACCOUNT = process.env.AUSPOST_ACCOUNT;
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const SHOPIFY_STORE = process.env.SHOPIFY_STORE; // e.g. your-store.myshopify.com

const AUSPOST_BASE = 'https://digitalapi.auspost.com.au/test/shipping/v1';

const auspostHeaders = {
  'Content-Type': 'application/json',
  'Account-Number': AUSPOST_ACCOUNT,
  'Authorization': 'Basic ' + Buffer.from(`${AUSPOST_API_KEY}:${AUSPOST_PASSWORD}`).toString('base64')
};

// ✅ Health check
app.get('/', (req, res) => {
  res.send('AusPost-Shopify server is running!');
});

// ✅ Step 2: Live rates for Shopify checkout
app.post('/rates', async (req, res) => {
  const { origin, destination, items } = req.body.rate;

  const totalWeight = items.reduce((sum, item) => sum + item.grams, 0);

  try {
    const response = await fetch(`${AUSPOST_BASE}/prices/items`, {
      method: 'POST',
      headers: auspostHeaders,
      body: JSON.stringify({
        from: {
          postcode: origin.postal_code,
          country: origin.country
        },
        to: {
          postcode: destination.postal_code,
          country: destination.country
        },
        items: [
          {
            weight: totalWeight / 1000, // grams to kg
            length: 10,
            width: 10,
            height: 10,
            product_id: '7E55' // Parcel Post + ATL
          },
          {
            weight: totalWeight / 1000, // grams to kg
            length: 10,
            width: 10,
            height: 10,
            product_id: '3K55' // Express Post + ATL
          }
        ]
      })
    });

    const data = await response.json();
    const rates = data.items?.[0]?.prices?.map(price => ({
      service_name: price.product_type,
      service_code: price.product_id,
      total_price: Math.round(price.calculated_price * 100), // cents
      currency: 'AUD',
      min_delivery_date: null,
      max_delivery_date: null
    })) || [];

    res.json({ rates });
  } catch (err) {
    console.error('Rates error:', err);
    res.json({ rates: [] });
  }
});

// ✅ Step 3: Create shipment + label when order is placed
app.post('/webhook/order', async (req, res) => {
  const order = req.body;
  const shipping = order.shipping_address;

  try {
    // Create shipment
    const shipmentRes = await fetch(`${AUSPOST_BASE}/shipments`, {
      method: 'POST',
      headers: auspostHeaders,
      body: JSON.stringify({
        shipments: [{
          shipment_reference: String(order.id),
          sender: {
            name: 'Your Store Name',
            lines: ['Your Street Address'],
            suburb: 'Your Suburb',
            state: 'VIC',
            postcode: '3000',
            country: 'AU',
            phone: '0400000000'
          },
          receiver: {
            name: `${shipping.first_name} ${shipping.last_name}`,
            lines: [shipping.address1],
            suburb: shipping.city,
            state: shipping.province_code,
            postcode: shipping.zip,
            country: shipping.country_code,
            phone: shipping.phone || order.phone || '0400000000'
          },
          items: [{
            item_reference: `item-${order.id}`,
            product_id: 'EXP',
            length: 10,
            width: 10,
            height: 10,
            weight: 1
          }]
        }]
      })
    });

    const shipmentData = await shipmentRes.json();
    const shipmentId = shipmentData.shipments?.[0]?.shipment_id;
    const trackingNumber = shipmentData.shipments?.[0]?.items?.[0]?.tracking_details?.article_id;

    if (!shipmentId) {
      console.error('No shipment ID returned', shipmentData);
      return res.sendStatus(200);
    }

    // Create label
    await fetch(`${AUSPOST_BASE}/labels`, {
      method: 'POST',
      headers: auspostHeaders,
      body: JSON.stringify({
        wait_for_label_url: true,
        shipments: [{ shipment_id: shipmentId }]
      })
    });

    // Send tracking back to Shopify
    if (trackingNumber) {
      const fulfillmentRes = await fetch(
        `https://${SHOPIFY_STORE}/admin/api/2024-01/orders/${order.id}/fulfillments.json`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN
          },
          body: JSON.stringify({
            fulfillment: {
              tracking_number: trackingNumber,
              tracking_company: 'Australia Post',
              notify_customer: true
            }
          })
        }
      );
      console.log('Fulfillment created:', await fulfillmentRes.json());
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Order webhook error:', err);
    res.sendStatus(200);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
