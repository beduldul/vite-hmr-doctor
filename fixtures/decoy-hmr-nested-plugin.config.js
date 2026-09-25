// Regression fixture: the `hmr` here belongs to a *plugin* object inside an
// array, not to `server.hmr`. The static scanner must not read it as
// configuration, even though it is a comma-preceded `hmr:` at what looks like a
// property boundary once strings are masked.
export default {
  server: {
    ws: false,
    plugins: [{ name: 'p', hmr: { port: 1 } }],
  },
};
