// server.hmr is NEVER set. The only ", hmr:" text is inside comments.
export default {
  server: {
    ws: false,
    // , hmr: { port: 24678 }
    /* , hmr: { timeout: 5000 } */
    port: 5173,
  },
};
