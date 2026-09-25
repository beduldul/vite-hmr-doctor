// server.hmr is NEVER set. The only ", hmr:" text is inside a template literal.
const note = `, hmr: { path: '/hmr' }`;
export default {
  server: { ws: false, note },
};
