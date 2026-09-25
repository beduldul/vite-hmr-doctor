// Check 1: several deprecated socket options set alongside ws: false.
// Note: hmr.overlay is deliberately NOT here — it is not a socket option and
// it does still take effect with ws: false (see README "Current Vite behaviour").
export default {
  server: {
    ws: false,
    hmr: {
      protocol: 'wss',
      host: 'localhost',
      port: 24678,
      clientPort: 443,
      path: '/hmr',
      timeout: 5000,
    },
  },
};
