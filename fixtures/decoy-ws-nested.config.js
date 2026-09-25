// Regression fixture: `ws: false` nested inside an array element. The real
// top-level `server.ws` is an object, so the nested literal must not be read as
// a top-level `ws: false`.
export default {
  server: {
    ws: { port: 5173 },
    plugins: [{ name: 'p', ws: false }],
  },
};
