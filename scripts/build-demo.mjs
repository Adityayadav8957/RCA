// Builds the free, static, serverless demo into ./demo (deploy that folder to Cloudflare Pages, GitHub Pages, Netlify ...).
import { build } from "esbuild";
import fs from "node:fs";

fs.rmSync("demo", { recursive: true, force: true });
fs.mkdirSync("demo", { recursive: true });

await build({
  entryPoints: ["src/sim/browser.ts"],
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2020",
  platform: "browser",
  outfile: "demo/sim.js",
  // The engine reads optional tuning knobs from process.env; in the browser there are none.
  banner: { js: "globalThis.process=globalThis.process||{env:{}};" },
  logLevel: "warning",
});

// Same dashboard as the real app, plus the simulator loaded BEFORE the dashboard's own script so it can answer /api/* calls.
let html = fs.readFileSync("dashboard/index.html", "utf8");
html = html.replace("<script>", '<script src="sim.js"></script>\n<script>');
fs.writeFileSync("demo/index.html", html);
fs.copyFileSync("scripts/headers.txt", "demo/_headers"); // security headers (CSP, nosniff, no framing ...)

const kb = (f) => (fs.statSync(f).size / 1024).toFixed(0) + " kB";
console.log(`demo built: demo/index.html (${kb("demo/index.html")}), demo/sim.js (${kb("demo/sim.js")})`);
