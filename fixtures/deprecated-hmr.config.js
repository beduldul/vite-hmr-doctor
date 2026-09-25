// Check 3: works, but deprecated in favour of server.ws.*.
export default {
  server: {
    hmr: { protocol: 'wss', host: 'example.com', port: 443 },
  },
};
