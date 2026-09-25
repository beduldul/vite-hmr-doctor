// Regression fixture: `hmr` nested inside a plain object literal at depth > 0,
// in a comma-preceded position. Not server.hmr config; must report nothing.
export default {
  server: {
    ws: false,
    plugin: { name: 'p', hmr: { port: 1 } },
  },
};
