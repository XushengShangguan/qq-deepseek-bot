// Next.js calls this once when the server starts.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startLife } = await import("./lib/life");
    startLife();
  }
}
