import { createServer } from 'node:http';

// Check 1 (transport case): the custom HMR transport is never attached.
export default {
  server: {
    ws: false,
    hmr: { server: createServer() },
  },
};
