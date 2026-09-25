// Negative fixture: hmr.overlay is NOT a socket option. Vite reads it with no
// guard (clientInjections, `hmrConfig?.overlay !== false`), so it works even
// with ws: false and must NOT be reported. Guards against a false positive.
export default {
  server: {
    ws: false,
    hmr: { overlay: false },
  },
};
