// Stand-in for broker.ts in the supervisor tests: binds DISCUSSION_TREE_PORT
// and answers /health, so the supervisor's health/standby logic sees a real
// listener, without opening a DB or building the web bundle.
//   GET /health -> {"status":"ok"}
//   GET /pid    -> this process's pid
//   GET /exit?code=N -> exits with N shortly after responding
// If the port is taken it exits 0, like the real broker's bind-failure catch.

const port = Number(process.env.DISCUSSION_TREE_PORT || "0");
try {
  Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") return Response.json({ status: "ok" });
      if (url.pathname === "/pid") return new Response(String(process.pid));
      if (url.pathname === "/exit") {
        const code = Number(url.searchParams.get("code") ?? "1");
        setTimeout(() => process.exit(code), 20);
        return new Response("bye");
      }
      return new Response("not found", { status: 404 });
    },
  });
  console.error(`[fake-broker ${process.pid}] listening on ${port}`);
} catch (e) {
  console.error(`[fake-broker ${process.pid}] bind failed: ${String(e)}`);
  process.exit(0);
}
