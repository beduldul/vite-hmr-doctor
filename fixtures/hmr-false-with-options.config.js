// Check 2: the hmr key is spelled twice; the last one wins, so hmr === false
// and the earlier options are unreachable.
export default {
  server: {
    hmr: { port: 1234 },
    hmr: false,
  },
};
