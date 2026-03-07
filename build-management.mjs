import { build } from "esbuild";

await build({
  entryPoints: ["src/management-app.jsx"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2020"],
  outdir: "public",
  entryNames: "management.bundle",
  assetNames: "management.bundle",
  loader: {
    ".js": "jsx",
    ".jsx": "jsx",
    ".css": "css",
  },
  jsx: "automatic",
  sourcemap: false,
  logLevel: "info",
});
