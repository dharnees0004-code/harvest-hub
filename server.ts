import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';
import { mockProducts, mockWarehouses, calculateDistanceKm } from './src/data/mockData';
import { INITIAL_DEMO_INVENTORY, WarehouseInventoryRecord } from './src/data/demoInventory';
import { hasValidCoordinates } from './src/utils/warehouseLocation';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json());

// Demo fulfillment API. This deliberately keeps inventory server-side: prices, stock,
// warehouse identity, and order totals are never accepted from the browser as truth.
let fulfillmentInventory: WarehouseInventoryRecord[] = INITIAL_DEMO_INVENTORY.map((record) => ({ ...record }));
const idempotentOrders = new Map<string, unknown>();

app.get('/api/inventory/:warehouseId/products/:productId/alternatives', (req, res) => {
  const { warehouseId, productId } = req.params;
  const product = mockProducts.find((item) => item.id === productId);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const alternatives = mockWarehouses
    .filter((warehouse) => warehouse.id !== warehouseId && warehouse.isOpen)
    .map((warehouse) => {
      const inventory = fulfillmentInventory.find((row) => row.warehouseId === warehouse.id && row.productId === productId);
      const distanceKm = hasValidCoordinates(lat, lng) && hasValidCoordinates(warehouse.latitude, warehouse.longitude)
        ? calculateDistanceKm(lat, lng, warehouse.latitude, warehouse.longitude) : undefined;
      return { warehouse, availableQuantity: inventory?.availableQuantity ?? 0, price: product.price, distanceKm, deliveryEstimate: warehouse.deliveryTimeMin === 'Estimate unavailable' ? undefined : warehouse.deliveryTimeMin };
    })
    .filter((result) => result.availableQuantity > 0)
    .sort((a, b) => (a.distanceKm ?? Number.MAX_SAFE_INTEGER) - (b.distanceKm ?? Number.MAX_SAFE_INTEGER));
  res.json({ alternatives });
});

app.post('/api/checkout', (req, res) => {
  const { customerId, items, idempotencyKey } = req.body ?? {};
  if (!customerId || !Array.isArray(items) || !idempotencyKey) return res.status(400).json({ error: 'customerId, items, and idempotencyKey are required.' });
  const prior = idempotentOrders.get(idempotencyKey);
  if (prior) return res.json(prior);
  if (!items.length) return res.status(400).json({ error: 'Cart is empty.' });
  const normalized = items.map((item: any) => ({ productId: String(item.productId || ''), warehouseId: String(item.warehouseId || ''), quantity: Number(item.quantity) }));
  for (const item of normalized) {
    const product = mockProducts.find((candidate) => candidate.id === item.productId);
    const warehouse = mockWarehouses.find((candidate) => candidate.id === item.warehouseId && candidate.isOpen);
    const record = fulfillmentInventory.find((candidate) => candidate.productId === item.productId && candidate.warehouseId === item.warehouseId);
    if (!product || !warehouse || !Number.isInteger(item.quantity) || item.quantity < 1 || !record || record.availableQuantity < item.quantity) {
      return res.status(409).json({ error: 'One or more cart items have changed or are no longer in stock.' });
    }
  }
  // This synchronous validation-and-deduction block is the atomic unit for the in-memory demo store.
  const orderId = `HH-ORD-${Date.now()}`;
  const grouped = new Map<string, typeof normalized>();
  for (const item of normalized) grouped.set(item.warehouseId, [...(grouped.get(item.warehouseId) ?? []), item]);
  for (const item of normalized) {
    const record = fulfillmentInventory.find((candidate) => candidate.productId === item.productId && candidate.warehouseId === item.warehouseId)!;
    record.availableQuantity -= item.quantity;
  }
  const suborders = Array.from(grouped.entries()).map(([warehouseId, group], index) => {
    const warehouse = mockWarehouses.find((candidate) => candidate.id === warehouseId)!;
    const orderItems = group.map((item) => {
      const product = mockProducts.find((candidate) => candidate.id === item.productId)!;
      return { productId: product.id, productName: product.name, quantity: item.quantity, unit: product.unit, unitPrice: product.price, warehouseId };
    });
    const subtotal = orderItems.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
    return { id: `${orderId}-SUB${index + 1}`, parentOrderId: orderId, warehouseId, warehouseName: warehouse.name, subtotal, deliveryFee: 0, status: 'Order Confirmed', deliveryEstimate: warehouse.deliveryTimeMin, items: orderItems };
  });
  const response = { id: orderId, customerId, paymentStatus: 'not_processed', status: 'Order Confirmed', subtotal: suborders.reduce((sum, order) => sum + order.subtotal, 0), total: suborders.reduce((sum, order) => sum + order.subtotal + order.deliveryFee, 0), suborders };
  idempotentOrders.set(idempotencyKey, response);
  res.status(201).json(response);
});

// POST /api/chat - Natural Language Parsing and Harvest Hub Store Querying with Gemini
app.post('/api/chat', async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      query,
      userLocation,
      cartItems = [],
      orders = [],
      availableProducts = [],
      availableWarehouses = [],
    } = req.body;

    if (!query || typeof query !== 'string') {
      res.status(400).json({ error: 'Missing user query string' });
      return;
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      // Return a graceful flag so client can use deterministic fallback engine
      res.json({
        geminiAvailable: false,
        message: 'No GEMINI_API_KEY provided; using Harvest Hub local engine.',
      });
      return;
    }

    const ai = new GoogleGenAI({ apiKey });

    // Prepare catalog summary for Gemini grounding
    const productSummary = (availableProducts.length > 0 ? availableProducts : [
      { name: 'Banana', category: 'fruits', price: 49, unit: 'kg', freshness: 'Very Fresh', brix: 16.0 },
      { name: 'Mango', category: 'fruits', price: 149, unit: 'kg', freshness: 'Very Fresh', brix: 18.5 },
      { name: 'Grapes', category: 'fruits', price: 119, unit: 'kg', freshness: 'Very Fresh', brix: 17.0 },
      { name: 'Papaya', category: 'fruits', price: 59, unit: 'kg', freshness: 'Very Fresh', brix: 13.5 },
      { name: 'Guava', category: 'fruits', price: 79, unit: 'kg', freshness: 'Very Fresh', brix: 12.0 },
      { name: 'Tomato', category: 'veggies', price: 38, unit: 'kg', freshness: 'Very Fresh' },
      { name: 'Onion', category: 'veggies', price: 34, unit: 'kg', freshness: 'Very Fresh' },
      { name: 'Potato', category: 'veggies', price: 32, unit: 'kg', freshness: 'Very Fresh' },
      { name: 'Carrot', category: 'veggies', price: 48, unit: 'kg', freshness: 'Very Fresh' },
      { name: 'Brinjal', category: 'veggies', price: 36, unit: 'kg', freshness: 'Very Fresh' },
      { name: 'Cabbage', category: 'veggies', price: 28, unit: 'kg', freshness: 'Very Fresh' },
      { name: 'Cauliflower', category: 'veggies', price: 42, unit: 'kg', freshness: 'Very Fresh' },
      { name: 'Ladies Finger', category: 'veggies', price: 38, unit: 'kg', freshness: 'Very Fresh' },
      { name: 'Beans', category: 'veggies', price: 52, unit: 'kg', freshness: 'Very Fresh' },
      { name: 'Green Chilli', category: 'veggies', price: 45, unit: 'kg', freshness: 'Very Fresh' },
      { name: 'Beetroot', category: 'veggies', price: 35, unit: 'kg', freshness: 'Very Fresh' },
      { name: 'Bottle Gourd', category: 'veggies', price: 28, unit: 'kg', freshness: 'Very Fresh' },
      { name: 'Ridge Gourd', category: 'veggies', price: 38, unit: 'kg', freshness: 'Very Fresh' },
      { name: 'Drumstick', category: 'veggies', price: 48, unit: 'kg', freshness: 'Very Fresh' },
      { name: 'Spinach', category: 'veggies', price: 26, unit: 'bunch', freshness: 'Very Fresh' },
      { name: 'Milk', category: 'dairy', price: 30, unit: '500ml pouch', freshness: 'Very Fresh' },
      { name: 'Curd', category: 'dairy', price: 35, unit: '400g cup', freshness: 'Very Fresh' },
      { name: 'Paneer', category: 'dairy', price: 85, unit: '200g pack', freshness: 'Very Fresh' },
      { name: 'Butter', category: 'dairy', price: 55, unit: '100g pack', freshness: 'Very Fresh' },
      { name: 'Cheese', category: 'dairy', price: 115, unit: '200g block', freshness: 'Very Fresh' },
    ]).map((p: any) => `${p.name} (${p.category}): ₹${p.price}/${p.unit}, Freshness: ${p.freshness || 'Very Fresh'}`).join('\n');

    const warehouseSummary = (availableWarehouses.length > 0 ? availableWarehouses : [
      { name: 'HarvestHub Warehouse – Coimbatore', location: 'Gandhipuram Central Hub', address: '14 Cross Cut Rd, Gandhipuram', lat: 11.0180, lng: 76.9650 },
      { name: 'HarvestHub Valley Depot – Coimbatore', location: 'RS Puram & DB Road', address: '88 DB Road, RS Puram', lat: 11.0080, lng: 76.9450 },
    ]).map((w: any) => `${w.name}: ${w.location} (${w.address})`).join('\n');

    const cartSummary = cartItems.length > 0
      ? cartItems.map((ci: any) => `${ci.product.name} x ${ci.quantity} (₹${ci.product.price * ci.quantity})`).join(', ')
      : 'Cart is currently empty';

    const orderSummary = orders.length > 0
      ? `Latest Order #${orders[0].id.slice(-6)}: Status: ${orders[0].status}, Items: ${orders[0].items.map((i: any) => `${i.product.name} x ${i.quantity}`).join(', ')}, Total: ₹${orders[0].totalAmount}`
      : 'No active orders in session';

    const systemPrompt = `You are the Harvest Hub AI Assistant. Your job is to parse the user's natural language grocery request with 100% precision.

HARVEST HUB CATALOG:
${productSummary}

FULFILLMENT WAREHOUSES:
${warehouseSummary}

CURRENT CUSTOMER CONTEXT:
- Active Location: ${userLocation?.addressName || 'Gandhipuram, Coimbatore'}
- Current Cart: ${cartSummary}
- Orders: ${orderSummary}

RULES:
1. Identify if the user mentions a location (e.g. "Saravanampatti", "Gandhipuram", "RS Puram", "near me").
2. Identify which Harvest Hub products are requested (e.g. "Mango", "Banana", "Tomato", etc.).
3. Identify if user wants the "freshest" produce.
4. Identify cart intent: if user wants to add items ("Add 2 kg mangoes"), remove items, or view cart.
5. Identify order intent: if user asks for order status, delivery tracking, or past orders.
6. If the user asks for non-existent items (e.g. electronics, clothes), state clearly that Harvest Hub only offers farm-direct Fruits, Vegetables, and Dairy.
7. Return a JSON object with this EXACT schema:
{
  "parsedIntent": "product_search" | "cart_add" | "cart_remove" | "cart_view" | "order_status" | "warehouse_search" | "app_guide" | "general",
  "extractedLocation": string or null,
  "matchedProducts": string[], // exact product names from catalog
  "isFreshestRequested": boolean,
  "cartAction": {
    "action": "add" | "remove" | "show" | "none",
    "productName": string or null,
    "quantity": number
  },
  "naturalSummary": string // A clear, helpful 1-3 sentence response
}`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: [
        { role: 'user', parts: [{ text: `${systemPrompt}\n\nUSER QUERY: "${query}"\n\nGenerate the JSON output:` }] },
      ],
      config: {
        responseMimeType: 'application/json',
      },
    });

    const responseText = response.text || '{}';
    let parsedResult: any = {};
    try {
      parsedResult = JSON.parse(responseText);
    } catch {
      parsedResult = { naturalSummary: responseText, matchedProducts: [] };
    }

    res.json({
      geminiAvailable: true,
      data: parsedResult,
    });
  } catch (error: any) {
    console.error('Gemini API chat error:', error);
    res.status(500).json({
      geminiAvailable: false,
      error: error?.message || 'Failed to process Gemini chat query',
    });
  }
});

// POST /api/voice-command - Voice AI App Controller powered by Gemini
app.post('/api/voice-command', async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      transcript,
      context = {},
      userLocation,
      cartItems = [],
      orders = [],
      availableProducts = [],
    } = req.body;

    if (!transcript || typeof transcript !== 'string') {
      res.status(400).json({ error: 'Missing transcript' });
      return;
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      res.json({
        geminiAvailable: false,
        message: 'No GEMINI_API_KEY provided; client fallback will execute.',
      });
      return;
    }

    const ai = new GoogleGenAI({ apiKey });

    const productNames = (availableProducts.length > 0 ? availableProducts.map((p: any) => p.name) : [
      'Banana', 'Mango', 'Grapes', 'Papaya', 'Guava',
      'Tomato', 'Onion', 'Potato', 'Carrot', 'Brinjal', 'Cabbage',
      'Cauliflower', 'Ladies Finger', 'Beans', 'Green Chilli',
      'Beetroot', 'Bottle Gourd', 'Ridge Gourd', 'Drumstick', 'Spinach',
      'Milk', 'Curd', 'Paneer', 'Butter', 'Cheese'
    ]).join(', ');

    const voicePrompt = `You are the Voice AI Controller for the Harvest Hub grocery web application.
The user speaks a voice command to control the app.
Your task is to parse their voice intent and convert it into a sequence of concrete application actions.

AVAILABLE APP ACTIONS:
- openHome: Navigate to Home screen
- openFruits: Open the Fresh Fruits section
- openFreshVegetables: Open the Fresh Vegetables category
- openMilkAndDairy: Open Pure Dairy category
- searchProduct: Search for a product { query: string }
- openProduct: Open product detail modal { productName: string }
- addToCart: Add item to cart { productName: string, quantity: number }
- removeFromCart: Remove item from cart { productName: string }
- updateCartQuantity: Update quantity in cart { productName: string, quantity: number }
- openCart: Open the sliding Cart drawer
- openCheckout: Open Checkout modal
- openOrders: Open Orders list modal
- openProfile: Open Profile modal
- findNearbyProduct: Find nearby produce { productName: string, location?: string }
- findNearbyWarehouse: Find closest warehouse { location?: string }
- goBack: Return to previous view or close modal

CATALOG PRODUCTS:
${productNames}

CURRENT CONVERSATION CONTEXT:
- Last Referenced Product: ${context.lastReferencedProduct || 'None'}
- Last Referenced Category: ${context.lastCategory || 'None'}
- Current Active View: ${context.activeView || 'home'}
- Cart Items: ${cartItems.length > 0 ? cartItems.map((c: any) => `${c.product.name} (${c.quantity})`).join(', ') : 'Empty'}
- User Location: ${userLocation?.addressName || 'Gandhipuram, Coimbatore'}

RULES:
1. Multi-Step Commands:
   Example: "Open fresh vegetables, find tomatoes and add two kilos to my cart"
   Must produce actions:
   [
     { "action": "openFreshVegetables" },
     { "action": "openProduct", "payload": { "productName": "Tomato" } },
     { "action": "addToCart", "payload": { "productName": "Tomato", "quantity": 2 } }
   ]
2. Context Retention:
   If user says "Add two kilos" and last referenced product was "Tomato", resolve productName to "Tomato"!
3. Spoken Response:
   Provide a natural, concise, friendly sentence for the Voice AI to speak back (e.g. "Sure, opening Fresh Fruits.", "Added 2 kg of tomatoes to your cart.", "Here are the available tomatoes.").
4. Cart & Removal:
   If user says "Remove tomatoes", action is removeFromCart.
   If user asks "What is in my cart?", action is openCart and spokenResponse summarizes items.
5. Confirmation:
   Set requiresConfirmation to true ONLY if user asks to empty entire cart or perform an ambiguous destructive action.

RETURN EXACT JSON:
{
  "actions": [
    { "action": string, "payload": object }
  ],
  "spokenResponse": string,
  "referencedProduct": string or null,
  "referencedCategory": string or null,
  "requiresConfirmation": boolean,
  "confirmationMessage": string or null
}`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: [
        { role: 'user', parts: [{ text: `${voicePrompt}\n\nUSER SPOKE: "${transcript}"\n\nGenerate JSON:` }] },
      ],
      config: {
        responseMimeType: 'application/json',
      },
    });

    const responseText = response.text || '{}';
    let parsed: any = {};
    try {
      parsed = JSON.parse(responseText);
    } catch {
      parsed = { actions: [], spokenResponse: "I couldn't quite understand that command. Please try again." };
    }

    res.json({
      geminiAvailable: true,
      data: parsed,
    });
  } catch (error: any) {
    console.error('Gemini Voice Command error:', error);
    res.status(500).json({
      geminiAvailable: false,
      error: error?.message || 'Failed to process voice command',
    });
  }
});

// Configure Vite integration for Full-Stack development
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`HarvestHub server with Gemini API listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
