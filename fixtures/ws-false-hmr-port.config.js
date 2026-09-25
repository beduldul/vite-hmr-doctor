// Check 1: server.ws is false, so server.hmr.port is silently dropped.
export default {
  server: {
    ws: false,
    hmr: { port: 5173 },
  },
};
