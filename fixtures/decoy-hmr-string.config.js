// server.hmr is NEVER set. The only ", hmr:" text is inside a string literal.
// Before the masking fix this was read as real config and reported (exit 1).
export default {
  server: { ws: false, note: ', hmr: { clientPort: 443 }' },
};
