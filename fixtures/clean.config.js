// Correct, current spelling. Expect: exit 0.
// Kept free of any import so the fixture loads with or without `vite` present.
export default {
  server: {
    port: 5173,
    ws: { port: 5174 },
  },
};
