// Positive control: a REAL top-level `server: { ws: false, hmr: { port } }`.
// The scanner must still read this as server.hmr and report one finding.
export default {
  server: {
    ws: false,
    hmr: { port: 1 },
  },
};
