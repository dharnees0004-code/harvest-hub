<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/b8874676-d676-4771-afde-76f600984934

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## Warehouse Ordering Demo

The store uses the existing warehouse selector and product catalog with sample stock defined in `src/data/demoInventory.ts`. Selecting a warehouse filters products and stock to that warehouse. Cart quantities cannot exceed its available demo stock, and changing warehouses with a non-empty cart requires clearing the cart or keeping the original warehouse.

This project has no order or inventory database/API. Demo stock and orders are stored in this browser's local storage; checkout revalidates stock, records unit-price snapshots, and displays an explicit local-demo confirmation. It does not submit orders to a warehouse or process payments. To reset demo inventory, remove the `harvesthub_demo_inventory` and `harvesthub_orders` entries from local storage for the app's origin. The cart and selected warehouse are stored separately as `harvesthub_cart` and `harvesthub_selected_warehouse`.

Product and warehouse photos are bundled under `public/images/catalog` and served locally, so the catalog does not depend on third-party image hosts at runtime. If a product photo is unavailable, product views show a category-specific visual fallback.

## Live map and road routes

The existing warehouse map uses Google Maps JavaScript API. To calculate road routes, enable the Routes API and billing for the Google Cloud project associated with the Maps browser key. Set `VITE_GOOGLE_MAPS_API_KEY` in `.env` to a browser key restricted to the app's allowed referrers and enabled APIs. No additional routing secret or dependency is required. Browser current-location access requires the user's permission and a secure context; `localhost` is supported for local development.

Start the app with `npm run dev`. Run `npm run lint` for the TypeScript check and `npm run build` for a production build.
