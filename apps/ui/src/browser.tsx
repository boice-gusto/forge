import { createForgeClient } from "@forge/sdk";
import { createRoot } from "react-dom/client";

import { ForgeApp } from "./app.js";
import "./styles.css";

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error(
    "Forge UI could not mount: no #root element in the document.",
  );
}

// Both values are read at runtime, not from a build-time env var: Vite inlines
// env vars into the bundle, which would ship a bearer token as a static asset.
// 012 §8 wants an IdP session and a CSRF token here instead; until the API
// accepts one, the operator supplies a token that dies with the tab.
const client = createForgeClient({
  baseUrl: sessionStorage.getItem("forge.apiUrl") ?? "http://127.0.0.1:3100",
  token: sessionStorage.getItem("forge.operatorToken") ?? "",
});

createRoot(rootElement).render(
  <ForgeApp
    client={client}
    dependencies={[
      { name: "api", status: "healthy" },
      { name: "worker", status: "healthy" },
      { name: "queue", status: "unavailable", detail: "Awaiting local Redis." },
    ]}
  />,
);
