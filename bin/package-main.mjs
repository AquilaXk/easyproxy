export const packageName = "easyproxy";
export const cliCommand = "epx";

export async function loadBunApi() {
  if (typeof Bun === "undefined") {
    throw new Error("The easyproxy programmatic API requires the Bun runtime. Use `epx` for the CLI entrypoint.");
  }
  return import("../src/index.ts");
}
