// Vercel serverless entry point — re-exports the request handler.
// vercel.json rewrites all paths here so the internal router handles routing.
export { handler as default } from "../src/server.mjs";
