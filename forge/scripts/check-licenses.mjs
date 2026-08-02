import { execFileSync } from "node:child_process";

const inventory = execFileSync("pnpm", ["licenses", "list", "--json"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
});
const licenses = Object.keys(JSON.parse(inventory));

if (licenses.length === 0) {
  throw new Error("Dependency license inventory is empty.");
}

process.stdout.write(
  `${JSON.stringify({ status: "ok", licenses: licenses.sort() })}\n`,
);
