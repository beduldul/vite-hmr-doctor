// Check 4: port set in both server.ws and server.hmr; server.ws wins.
export default {
  server: {
    ws: { port: 5000 },
    hmr: { port: 6000 },
  },
};
