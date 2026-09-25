// Regression fixture: `hmr` nested inside an array element, at depth > 0
// within the server block. Not server.hmr config; must report nothing.
export default {
  server: {
    ws: false,
    helpers: [{ name: 'x', hmr: { port: 1 } }],
  },
};
